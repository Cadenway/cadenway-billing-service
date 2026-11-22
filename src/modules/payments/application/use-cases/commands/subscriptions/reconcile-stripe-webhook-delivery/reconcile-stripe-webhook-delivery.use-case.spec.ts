import { describe, expect, it, vi } from 'vitest';

import type { StripeWebhookDelivery } from '../../../../models/webhooks/stripe-webhook-delivery.model.js';
import type { StripeBindingReader } from '../../../../ports/outbound/persistence/subscriptions/stripe-binding-reader.port.js';
import type { StripeWebhookBindingReader } from '../../../../ports/outbound/persistence/subscriptions/stripe-webhook-binding-reader.port.js';
import type { ReconcileStripeSubscription } from '../reconcile-stripe-subscription/reconcile-stripe-subscription.use-case.js';
import type { ReconcileStripeCheckout } from '../../checkout/reconcile-stripe-checkout/reconcile-stripe-checkout.use-case.js';
import { ReconcileStripeWebhookDelivery } from './reconcile-stripe-webhook-delivery.use-case.js';

const delivery = {
  kind: 'subscription',
  organizationId: 'atelier-nord',
  eventId: 'evt_fixture',
  customerId: 'cus_fixture',
  subscriptionId: 'sub_fixture',
} as const satisfies StripeWebhookDelivery;

function setup() {
  const hasSettlement = vi
    .fn<StripeWebhookBindingReader['hasSettlement']>()
    .mockResolvedValue(false);
  const resolve = vi.fn<StripeWebhookBindingReader['resolve']>();
  const readTenantBinding = vi.fn<StripeBindingReader['read']>().mockResolvedValue(null);
  const subscription = vi.fn<ReconcileStripeSubscription['execute']>();
  const checkout = vi.fn<ReconcileStripeCheckout['execute']>();
  return {
    hasSettlement,
    resolve,
    readTenantBinding,
    subscription,
    checkout,
    reconcile: new ReconcileStripeWebhookDelivery(
      { hasSettlement, resolve },
      readTenantBinding,
      subscription,
      checkout,
    ),
  };
}

describe('ReconcileStripeWebhookDelivery', () => {
  it('refreshes the subscription revision on every retry', async () => {
    const { resolve, subscription, reconcile } = setup();
    const binding = {
      organizationId: delivery.organizationId,
      binding: { customerId: delivery.customerId, subscriptionId: delivery.subscriptionId },
    };
    const first = { ...binding, revision: 2 };
    const next = { ...binding, revision: 3 };
    resolve.mockResolvedValueOnce(first).mockResolvedValue(next);
    subscription
      .mockResolvedValueOnce({ status: 'retry' })
      .mockResolvedValue({ status: 'applied' });

    await expect(reconcile.execute(delivery)).resolves.toBe('retry');
    await expect(reconcile.execute(delivery)).resolves.toBe('settled');
    expect(subscription.mock.calls.map(([input]) => input.acceptedBinding)).toEqual([first, next]);
  });

  it('keeps an unresolved or reassigned subscription outside settlement', async () => {
    const { resolve, subscription, reconcile } = setup();
    resolve.mockResolvedValueOnce(null).mockResolvedValue({
      organizationId: 'autre-atelier',
      binding: { customerId: delivery.customerId, subscriptionId: delivery.subscriptionId },
      revision: 4,
    });

    await expect(reconcile.execute(delivery)).resolves.toBe('retry');
    await expect(reconcile.execute(delivery)).resolves.toBe('retry');
    expect(subscription).not.toHaveBeenCalled();
  });

  it('accepts a committed subscription receipt before another provider lookup', async () => {
    const { hasSettlement, resolve, subscription, reconcile } = setup();
    hasSettlement.mockResolvedValue(true);

    await expect(reconcile.execute(delivery)).resolves.toBe('settled');
    expect(resolve).not.toHaveBeenCalled();
    expect(subscription).not.toHaveBeenCalled();
  });

  it('ends pending work when the admitted subscription has been replaced for the same customer', async () => {
    const { resolve, readTenantBinding, subscription, reconcile } = setup();
    resolve.mockResolvedValue(null);
    readTenantBinding.mockResolvedValue({
      revision: 7,
      binding: { customerId: delivery.customerId, subscriptionId: 'sub_replacement' },
    });

    await expect(reconcile.execute(delivery)).resolves.toBe('settled');
    expect(readTenantBinding).toHaveBeenCalledExactlyOnceWith(delivery.organizationId);
    expect(subscription).not.toHaveBeenCalled();
  });

  it('keeps work pending without proof that the same customer replaced the subscription', async () => {
    const { resolve, readTenantBinding, subscription, reconcile } = setup();
    resolve.mockResolvedValue(null);
    readTenantBinding.mockResolvedValue({
      revision: 7,
      binding: { customerId: 'cus_unknown', subscriptionId: 'sub_replacement' },
    });

    await expect(reconcile.execute(delivery)).resolves.toBe('retry');
    expect(subscription).not.toHaveBeenCalled();
  });

  it('anchors Checkout settlement to the admitted tenant', async () => {
    const { checkout, reconcile } = setup();
    checkout.mockResolvedValue({ status: 'duplicate' });

    await expect(
      reconcile.execute({
        kind: 'checkout',
        organizationId: delivery.organizationId,
        eventId: delivery.eventId,
        sessionId: 'cs_test_fixture',
      }),
    ).resolves.toBe('settled');
    expect(checkout).toHaveBeenCalledExactlyOnceWith({
      eventId: delivery.eventId,
      sessionId: 'cs_test_fixture',
      expectedOrganizationId: delivery.organizationId,
    });
  });
});
