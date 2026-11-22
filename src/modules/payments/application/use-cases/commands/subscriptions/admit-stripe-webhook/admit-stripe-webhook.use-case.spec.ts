import { describe, expect, it, vi } from 'vitest';

import type { StripeWebhookAuthenticator } from '../../../../models/subscriptions/stripe-webhook-authenticator.model.js';
import type { StripeCheckoutAttemptReader } from '../../../../ports/outbound/persistence/checkout/stripe-checkout-attempt-reader.port.js';
import type { StripeWebhookInbox } from '../../../../ports/outbound/persistence/webhooks/stripe-webhook-inbox.port.js';
import type { ReconcileStripeSubscription } from '../reconcile-stripe-subscription/reconcile-stripe-subscription.use-case.js';
import type { ReconcileStripeCheckout } from '../../checkout/reconcile-stripe-checkout/reconcile-stripe-checkout.use-case.js';
import { AdmitStripeWebhook } from './admit-stripe-webhook.use-case.js';

const subscription = {
  kind: 'subscription',
  eventId: 'evt_test',
  customerId: 'cus_test',
  subscriptionId: 'sub_test',
} as const;
const binding = {
  organizationId: 'atelier-nord',
  binding: { customerId: subscription.customerId, subscriptionId: subscription.subscriptionId },
  revision: 42,
};
const input = { rawBody: Uint8Array.from([0x7b, 0x7d]), signature: 'signed-fixture' };

function setup() {
  const authenticate = vi.fn<StripeWebhookAuthenticator>().mockReturnValue(subscription);
  const hasSettlement = vi.fn().mockResolvedValue(false);
  const resolve = vi.fn().mockResolvedValue(binding);
  const settle = vi
    .fn<ReconcileStripeSubscription['execute']>()
    .mockResolvedValue({ status: 'applied' });
  return {
    authenticate,
    hasSettlement,
    resolve,
    settle,
    useCase: new AdmitStripeWebhook(authenticate, { hasSettlement, resolve }, settle),
  };
}

describe('AdmitStripeWebhook', () => {
  it.each(['applied', 'unchanged', 'expired', 'duplicate'] as const)(
    'acknowledges Checkout only after settlement returns %s',
    async (status) => {
      const { authenticate, hasSettlement, resolve, settle } = setup();
      authenticate.mockReturnValue({
        kind: 'checkout',
        eventId: 'evt_checkout',
        sessionId: 'cs_test',
      });
      const checkout = vi.fn<ReconcileStripeCheckout['execute']>().mockResolvedValue({ status });
      const useCase = new AdmitStripeWebhook(
        authenticate,
        { hasSettlement, resolve },
        settle,
        checkout,
      );

      await expect(useCase.execute(input)).resolves.toBe('accepted');
      expect(checkout).toHaveBeenCalledExactlyOnceWith({
        eventId: 'evt_checkout',
        sessionId: 'cs_test',
      });
      expect(hasSettlement).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
      expect(settle).not.toHaveBeenCalled();
    },
  );

  it('leaves Checkout retryable when settlement is unavailable or deferred', async () => {
    const { authenticate, hasSettlement, resolve, settle } = setup();
    authenticate.mockReturnValue({
      kind: 'checkout',
      eventId: 'evt_checkout',
      sessionId: 'cs_test',
    });
    const checkout = vi
      .fn<ReconcileStripeCheckout['execute']>()
      .mockResolvedValue({ status: 'retry' });
    await expect(
      new AdmitStripeWebhook(authenticate, { hasSettlement, resolve }, settle).execute(input),
    ).resolves.toBe('unavailable');
    await expect(
      new AdmitStripeWebhook(authenticate, { hasSettlement, resolve }, settle, checkout).execute(
        input,
      ),
    ).resolves.toBe('unavailable');
  });

  it.each(['applied', 'unchanged', 'ignored', 'duplicate'] as const)(
    'acknowledges a supported delivery only after the durable settlement returns %s',
    async (status) => {
      const { useCase, resolve, settle } = setup();
      settle.mockResolvedValue({ status });
      await expect(useCase.execute(input)).resolves.toBe('accepted');
      expect(resolve).toHaveBeenCalledExactlyOnceWith({
        account: null,
        authContext: null,
        customerId: subscription.customerId,
        subscriptionId: subscription.subscriptionId,
      });
      expect(settle).toHaveBeenCalledExactlyOnceWith({
        organizationId: binding.organizationId,
        eventId: subscription.eventId,
        acceptedBinding: binding,
      });
    },
  );

  it.each([
    'ignored',
    'invalid-signature',
    'invalid-event',
    'body-too-large',
    'unavailable',
  ] as const)('does not access tenant bindings for authentication outcome %s', async (kind) => {
    const { authenticate, hasSettlement, resolve, settle, useCase } = setup();
    authenticate.mockReturnValue({ kind });
    await expect(useCase.execute(input)).resolves.toBe(kind);
    expect(hasSettlement).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it('leaves supported deliveries retryable until the real settlement is bound', async () => {
    const { authenticate, hasSettlement, resolve } = setup();
    await expect(
      new AdmitStripeWebhook(authenticate, { hasSettlement, resolve }, null).execute(input),
    ).resolves.toBe('unavailable');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('acknowledges a previously settled ID without the binding or settlement executor', async () => {
    const { authenticate, hasSettlement, resolve } = setup();
    hasSettlement.mockResolvedValue(true);
    await expect(
      new AdmitStripeWebhook(authenticate, { hasSettlement, resolve }, null).execute(input),
    ).resolves.toBe('accepted');
    expect(hasSettlement).toHaveBeenCalledExactlyOnceWith(subscription.eventId);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('leaves a known subscription event retryable if its exact binding is unavailable', async () => {
    const { resolve, settle, useCase } = setup();
    resolve.mockResolvedValue(null);
    await expect(useCase.execute(input)).resolves.toBe('unavailable');
    expect(settle).not.toHaveBeenCalled();
  });

  it('does not acknowledge a deferred settlement', async () => {
    const { settle, useCase } = setup();
    settle.mockResolvedValue({ status: 'retry' });
    await expect(useCase.execute(input)).resolves.toBe('unavailable');
  });

  it('acknowledges only once the inbox records the resolved subscription delivery', async () => {
    const { authenticate, hasSettlement, resolve, settle } = setup();
    const enqueue = vi
      .fn<StripeWebhookInbox['enqueue']>()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const checkoutAttempts: StripeCheckoutAttemptReader = {
      hasSettlement: vi.fn().mockResolvedValue(false),
      resolve: vi.fn().mockResolvedValue(null),
    };
    const useCase = new AdmitStripeWebhook(authenticate, { hasSettlement, resolve }, settle, null, {
      checkoutAttempts,
      enqueue,
    });
    await expect(useCase.execute(input)).resolves.toBe('unavailable');
    await expect(useCase.execute(input)).resolves.toBe('accepted');
    expect(enqueue).toHaveBeenCalledWith({
      ...subscription,
      organizationId: binding.organizationId,
    });
    expect(settle).not.toHaveBeenCalled();
  });

  it('requires an exact Checkout reservation and falls back for incomplete signed snapshots', async () => {
    const { authenticate, hasSettlement, resolve, settle } = setup();
    const delivery = { kind: 'checkout', eventId: 'evt_checkout', sessionId: 'cs_test' } as const;
    const checkout = vi
      .fn<ReconcileStripeCheckout['execute']>()
      .mockResolvedValue({ status: 'duplicate' });
    const lookup = vi
      .fn<StripeCheckoutAttemptReader['resolve']>()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ organizationId: binding.organizationId });
    const enqueue = vi.fn<StripeWebhookInbox['enqueue']>().mockResolvedValue(true);
    const useCase = new AdmitStripeWebhook(
      authenticate,
      { hasSettlement, resolve },
      settle,
      checkout,
      {
        checkoutAttempts: { hasSettlement: vi.fn().mockResolvedValue(false), resolve: lookup },
        enqueue,
      },
    );
    authenticate.mockReturnValue({ ...delivery, providerKey: 'checkout_known' });
    await expect(useCase.execute(input)).resolves.toBe('unavailable');
    await expect(useCase.execute(input)).resolves.toBe('accepted');
    expect(lookup).toHaveBeenCalledWith('checkout_known');
    expect(enqueue).toHaveBeenCalledExactlyOnceWith({
      ...delivery,
      organizationId: binding.organizationId,
    });
    expect(checkout).not.toHaveBeenCalled();

    authenticate.mockReturnValue(delivery);
    await expect(useCase.execute(input)).resolves.toBe('accepted');
    expect(checkout).toHaveBeenCalledExactlyOnceWith({
      eventId: delivery.eventId,
      sessionId: delivery.sessionId,
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});
