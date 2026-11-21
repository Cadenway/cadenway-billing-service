import { describe, expect, it, vi } from 'vitest';

import type { StripeCheckoutSession } from '../../../../models/checkout/stripe-checkout-session.model.js';
import type { StripeCheckoutAttemptReader } from '../../../../ports/outbound/persistence/checkout/stripe-checkout-attempt-reader.port.js';
import type { StripeCheckoutSessionReader } from '../../../../ports/outbound/providers/checkout/stripe-checkout-session-reader.port.js';
import type { StripeSubscriptionProvider } from '../../../../ports/outbound/providers/subscriptions/stripe-subscription-provider.port.js';
import type { StripeCheckoutSettlement } from '../../../../ports/outbound/transactions/checkout/stripe-checkout-settlement.port.js';
import { ReconcileStripeCheckout } from './reconcile-stripe-checkout.use-case.js';

const input = { eventId: 'evt_checkout', sessionId: 'cs_fixture' };
const completed: Extract<StripeCheckoutSession, { readonly status: 'complete' }> = {
  status: 'complete',
  sessionId: 'cs_fixture',
  providerKey: 'checkout_fixture',
  liveMode: false,
  customerId: 'cus_fixture',
  subscriptionId: 'sub_fixture',
  priceId: 'price_team',
  quantity: 7,
};
const subscription = {
  customerId: 'cus_fixture',
  subscriptionId: 'sub_fixture',
  liveMode: false,
  status: 'active',
  scheduledCancellation: false,
  collectionPaused: false,
  hasMoreItems: false,
  items: [{ priceId: 'price_team', quantity: 7 }],
};
const settings = {
  liveMode: false,
  teamPriceIds: ['price_team'],
  freePlanLimits: { seats: 5, storageBytes: 2_000_000_000 },
};

function setup() {
  const calls: string[] = [];
  const attempts: StripeCheckoutAttemptReader = {
    hasSettlement: vi.fn().mockImplementation(() => {
      calls.push('receipt');
      return Promise.resolve(false);
    }),
    resolve: vi.fn().mockImplementation(() => {
      calls.push('reservation');
      return Promise.resolve({ organizationId: 'tenant-a' });
    }),
  };
  const sessions: StripeCheckoutSessionReader = {
    retrieve: vi.fn().mockImplementation(() => {
      calls.push('session');
      return Promise.resolve(completed);
    }),
  };
  const subscriptions: StripeSubscriptionProvider = {
    retrieve: vi.fn().mockImplementation(() => {
      calls.push('subscription');
      return Promise.resolve(subscription);
    }),
  };
  const settlement: StripeCheckoutSettlement = {
    settle: vi.fn().mockImplementation(() => {
      calls.push('settlement');
      return Promise.resolve('applied');
    }),
  };
  return {
    attempts,
    sessions,
    subscriptions,
    settlement,
    calls,
    useCase: new ReconcileStripeCheckout(attempts, sessions, subscriptions, settlement, settings),
  };
}

describe('ReconcileStripeCheckout', () => {
  it('reads canonical provider state before the atomic tenant settlement', async () => {
    const { useCase, settlement, calls } = setup();
    await expect(useCase.execute(input)).resolves.toEqual({ status: 'applied' });
    expect(calls).toEqual(['receipt', 'session', 'reservation', 'subscription', 'settlement']);
    expect(settlement.settle).toHaveBeenCalledExactlyOnceWith({
      organizationId: 'tenant-a',
      eventId: input.eventId,
      session: completed,
      decision: {
        kind: 'apply',
        plan: 'team',
        limits: { seats: 7, storageBytes: 100_000_000_000 },
        scheduledCancellation: false,
      },
    });
  });

  it('acknowledges a committed receipt without depending on provider availability', async () => {
    const { useCase, attempts, sessions, settlement } = setup();
    vi.mocked(attempts.hasSettlement).mockResolvedValue(true);
    await expect(useCase.execute(input)).resolves.toEqual({ status: 'duplicate' });
    expect(sessions.retrieve).not.toHaveBeenCalled();
    expect(settlement.settle).not.toHaveBeenCalled();
  });

  it('accepts a duplicate that committed while the reservation was being resolved', async () => {
    const { useCase, attempts, subscriptions } = setup();
    vi.mocked(attempts.resolve).mockResolvedValue(null);
    vi.mocked(attempts.hasSettlement).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await expect(useCase.execute(input)).resolves.toEqual({ status: 'duplicate' });
    expect(subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it.each([
    { status: 'pending' },
    { ...completed, liveMode: true },
    { ...completed, providerKey: '' },
    { ...completed, sessionId: 'cs_other' },
  ] as StripeCheckoutSession[])('retries an untrusted or nonterminal session', async (session) => {
    const { useCase, sessions, attempts, settlement } = setup();
    vi.mocked(sessions.retrieve).mockResolvedValue(session);
    await expect(useCase.execute(input)).resolves.toEqual({ status: 'retry' });
    expect(attempts.resolve).not.toHaveBeenCalled();
    expect(settlement.settle).not.toHaveBeenCalled();
  });

  it('keeps a session with no Billing-owned reservation retryable', async () => {
    const { useCase, attempts, settlement } = setup();
    vi.mocked(attempts.resolve).mockResolvedValue(null);
    await expect(useCase.execute(input)).resolves.toEqual({ status: 'retry' });
    expect(settlement.settle).not.toHaveBeenCalled();
  });

  it('atomically records an expired session without creating a binding', async () => {
    const { useCase, sessions, subscriptions, settlement } = setup();
    const expired = {
      status: 'expired',
      sessionId: input.sessionId,
      providerKey: completed.providerKey,
      liveMode: false,
    } as const;
    vi.mocked(sessions.retrieve).mockResolvedValue(expired);
    vi.mocked(settlement.settle).mockResolvedValue('expired');
    await expect(useCase.execute(input)).resolves.toEqual({ status: 'expired' });
    expect(subscriptions.retrieve).not.toHaveBeenCalled();
    expect(settlement.settle).toHaveBeenCalledExactlyOnceWith({
      organizationId: 'tenant-a',
      eventId: input.eventId,
      session: expired,
      decision: null,
    });
  });

  it.each([
    { ...subscription, status: 'incomplete' },
    { ...subscription, status: 'past_due' },
    { ...subscription, liveMode: true },
    { ...subscription, customerId: 'cus_other' },
    { ...subscription, subscriptionId: 'sub_other' },
    { ...subscription, items: [{ priceId: 'price_unknown', quantity: 7 }] },
    { ...subscription, items: [{ priceId: 'price_team', quantity: 6 }] },
  ])(
    'does not commit when the subscription cannot prove the purchased Team plan',
    async (current) => {
      const { useCase, subscriptions, settlement } = setup();
      vi.mocked(subscriptions.retrieve).mockResolvedValue(current);
      await expect(useCase.execute(input)).resolves.toEqual({ status: 'retry' });
      expect(settlement.settle).not.toHaveBeenCalled();
    },
  );

  it('leaves an unfenced quota change retryable', async () => {
    const { useCase, settlement } = setup();
    vi.mocked(settlement.settle).mockResolvedValue('retry');
    await expect(useCase.execute(input)).resolves.toEqual({ status: 'retry' });
  });
});
