import { describe, expect, it, vi } from 'vitest';

import type { StripeBindingSnapshot } from '../../../../models/subscriptions/stripe-binding-snapshot.model.js';
import type { StripeBindingReader } from '../../../../ports/outbound/persistence/subscriptions/stripe-binding-reader.port.js';
import type { StripeSubscriptionProvider } from '../../../../ports/outbound/providers/subscriptions/stripe-subscription-provider.port.js';
import type { StripeReconciliationTransaction } from '../../../../ports/outbound/transactions/subscriptions/stripe-reconciliation-transaction.port.js';
import type { StripeReconciliationUnitOfWork } from '../../../../ports/outbound/transactions/subscriptions/stripe-reconciliation-unit-of-work.port.js';
import { ReconcileStripeSubscription } from './reconcile-stripe-subscription.use-case.js';

const binding: StripeBindingSnapshot = {
  revision: 3,
  binding: { customerId: 'cus_a', subscriptionId: 'sub_a' },
};
const input = { organizationId: 'organization-a', eventId: 'evt_123', acceptedBinding: binding };
const subscription = {
  ...binding.binding,
  liveMode: false,
  status: 'active',
  scheduledCancellation: false,
  collectionPaused: false,
  hasMoreItems: false,
  items: [{ priceId: 'price_team', quantity: 18 }],
};
const settings = {
  liveMode: false,
  teamPriceIds: ['price_team'],
  freePlanLimits: { seats: 5, storageBytes: 2_000_000_000 },
};

function setup(freeReturnEnabled = false) {
  const calls: string[] = [];
  const bindings: StripeBindingReader = {
    read: vi.fn().mockImplementation(() => {
      calls.push('binding');
      return Promise.resolve(binding);
    }),
  };
  const provider: StripeSubscriptionProvider = {
    retrieve: vi.fn().mockImplementation(() => {
      calls.push('provider');
      return Promise.resolve(subscription);
    }),
  };
  const transaction: StripeReconciliationTransaction = {
    lockBinding: vi.fn().mockResolvedValue(binding),
    isSettled: vi.fn().mockResolvedValue(false),
    apply: vi.fn().mockResolvedValue('applied'),
    settle: vi.fn().mockResolvedValue(undefined),
  };
  const work: StripeReconciliationUnitOfWork = {
    run: async <T>(
      _organizationId: string,
      callback: (value: StripeReconciliationTransaction) => Promise<T>,
    ): Promise<T> => {
      calls.push('transaction');
      return await callback(transaction);
    },
  };
  vi.spyOn(work, 'run');
  return {
    bindings,
    provider,
    transaction,
    calls,
    work,
    useCase: new ReconcileStripeSubscription(bindings, provider, work, {
      ...settings,
      freeReturnEnabled,
    }),
  };
}

describe('ReconcileStripeSubscription', () => {
  it('fetches Stripe outside settlement and applies the current Team entitlement', async () => {
    const { useCase, calls, provider, work, transaction } = setup();
    await expect(useCase.execute(input)).resolves.toEqual({ status: 'applied' });
    expect(calls).toEqual(['transaction', 'binding', 'provider', 'transaction']);
    expect(provider.retrieve).toHaveBeenCalledWith('sub_a');
    expect(work.run).toHaveBeenCalledWith(input.organizationId, expect.any(Function));
    expect(transaction.apply).toHaveBeenCalledWith({
      kind: 'apply',
      plan: 'team',
      limits: { seats: 18, storageBytes: 100_000_000_000 },
      scheduledCancellation: false,
    });
    expect(transaction.settle).toHaveBeenCalledWith(input.eventId);
  });

  it('returns a settled event without calling the provider or locking the binding', async () => {
    const { useCase, bindings, provider, transaction, work } = setup();
    vi.mocked(transaction.isSettled).mockResolvedValue(true);
    await expect(useCase.execute(input)).resolves.toEqual({ status: 'duplicate' });
    expect(work.run).toHaveBeenCalledOnce();
    expect(transaction.isSettled).toHaveBeenCalledWith(input.eventId);
    expect(bindings.read).not.toHaveBeenCalled();
    expect(provider.retrieve).not.toHaveBeenCalled();
    expect(transaction.lockBinding).not.toHaveBeenCalled();
    expect(transaction.apply).not.toHaveBeenCalled();
    expect(transaction.settle).not.toHaveBeenCalled();
  });

  it('checks again under the binding lock when another delivery settles after the first read', async () => {
    const { useCase, provider, transaction, calls } = setup();
    vi.mocked(transaction.isSettled).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await expect(useCase.execute(input)).resolves.toEqual({ status: 'duplicate' });
    expect(calls).toEqual(['transaction', 'binding', 'provider', 'transaction']);
    expect(provider.retrieve).toHaveBeenCalledOnce();
    expect(transaction.lockBinding).toHaveBeenCalledOnce();
    expect(transaction.isSettled).toHaveBeenCalledTimes(2);
    expect(transaction.apply).not.toHaveBeenCalled();
    expect(transaction.settle).not.toHaveBeenCalled();
  });

  it('acknowledges a concurrent delivery that committed before the binding read', async () => {
    const { useCase, bindings, provider, transaction } = setup();
    vi.mocked(transaction.isSettled).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    vi.mocked(bindings.read).mockResolvedValue({ ...binding, revision: 4 });

    await expect(useCase.execute(input)).resolves.toEqual({ status: 'duplicate' });
    expect(transaction.isSettled).toHaveBeenCalledTimes(2);
    expect(provider.retrieve).not.toHaveBeenCalled();
  });

  it('retries provider access when the receipt is absent after an earlier failed settlement', async () => {
    const { useCase, provider, transaction } = setup();
    vi.mocked(transaction.apply).mockRejectedValueOnce(new Error('settlement rolled back'));
    await expect(useCase.execute(input)).rejects.toThrow('settlement rolled back');
    await expect(useCase.execute(input)).resolves.toEqual({ status: 'applied' });
    expect(provider.retrieve).toHaveBeenCalledTimes(2);
    expect(transaction.settle).toHaveBeenCalledOnce();
  });

  it.each([
    null,
    { ...binding, revision: 4 },
    { ...binding, binding: { ...binding.binding, customerId: 'cus_changed' } },
  ])('retries if current binding or its reconciliation revision changed', async (current) => {
    const { useCase, transaction } = setup();
    vi.mocked(transaction.lockBinding).mockResolvedValue(current);
    await expect(useCase.execute(input)).resolves.toEqual({ status: 'retry' });
    expect(transaction.apply).not.toHaveBeenCalled();
    expect(transaction.settle).not.toHaveBeenCalled();
  });

  it('keeps cancellation pending while returns to Free are disabled', async () => {
    const { useCase, provider, transaction } = setup();
    vi.mocked(provider.retrieve).mockResolvedValue({ ...subscription, status: 'canceled' });
    await expect(useCase.execute(input)).resolves.toEqual({ status: 'retry' });
    expect(transaction.apply).not.toHaveBeenCalled();
    expect(transaction.settle).not.toHaveBeenCalled();
  });

  it('applies Free at exactly five seats and two billion bytes', async () => {
    const { useCase, provider, transaction } = setup(true);
    vi.mocked(provider.retrieve).mockResolvedValue({ ...subscription, status: 'canceled' });
    await expect(useCase.execute(input)).resolves.toEqual({ status: 'applied' });
    expect(transaction.apply).toHaveBeenCalledWith({
      kind: 'apply',
      plan: 'free',
      limits: { seats: 5, storageBytes: 2_000_000_000 },
    });
    expect(transaction.settle).toHaveBeenCalledWith(input.eventId);
  });

  it('leaves the event retryable if the current snapshot does not allow the change', async () => {
    const { useCase, transaction } = setup();
    vi.mocked(transaction.apply).mockResolvedValue('deferred');
    await expect(useCase.execute(input)).resolves.toEqual({ status: 'retry' });
    expect(transaction.settle).not.toHaveBeenCalled();
  });

  it('settles an ignored provider mismatch and advances the reconciliation fence', async () => {
    const { useCase, provider, transaction } = setup();
    vi.mocked(provider.retrieve).mockResolvedValue({ ...subscription, customerId: 'cus_other' });
    await expect(useCase.execute(input)).resolves.toEqual({ status: 'ignored' });
    expect(transaction.apply).not.toHaveBeenCalled();
    expect(transaction.settle).toHaveBeenCalledWith(input.eventId);
  });

  it('propagates an uncertain Stripe read without opening the settlement transaction', async () => {
    const { useCase, provider, work } = setup();
    vi.mocked(provider.retrieve).mockRejectedValue(new Error('unavailable'));
    await expect(useCase.execute(input)).rejects.toThrow('unavailable');
    expect(work.run).toHaveBeenCalledOnce();
  });

  it('leaves a missing binding retryable without calling Stripe', async () => {
    const { useCase, bindings, provider } = setup();
    vi.mocked(bindings.read).mockResolvedValue(null);
    await expect(useCase.execute(input)).resolves.toEqual({ status: 'retry' });
    expect(provider.retrieve).not.toHaveBeenCalled();
  });

  it('does not fetch a replacement Stripe binding for an older admitted delivery', async () => {
    const { useCase, bindings, provider, transaction } = setup();
    vi.mocked(bindings.read).mockResolvedValue({
      revision: binding.revision + 1,
      binding: { customerId: 'cus_new', subscriptionId: 'sub_new' },
    });
    await expect(useCase.execute(input)).resolves.toEqual({ status: 'retry' });
    expect(provider.retrieve).not.toHaveBeenCalled();
    expect(transaction.settle).not.toHaveBeenCalled();
  });
});
