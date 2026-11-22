import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveStripeSubscription } from '../../../domain/policies/subscriptions/stripe-subscription.policy.js';

import { createStripeSubscriptionProvider } from './stripe-subscription-provider.adapter.js';

const sdk = vi.hoisted(() => ({
  configure: vi.fn<(options: unknown) => void>(),
  retrieve: vi.fn<(id: string) => Promise<unknown>>(),
}));

vi.mock('stripe', () => ({
  default: class {
    // #region Properties
    /** Exposes only the SDK operation used by this adapter. */
    public readonly subscriptions = { retrieve: sdk.retrieve };
    // #endregion

    // #region Constructor
    /** Records transport policies without retaining the credential. */
    public constructor(_credential: string, options: unknown) {
      sdk.configure(options);
    }
    // #endregion
  },
}));

const subscriptionId = 'sub_atelier_nord';
const customerId = 'cus_atelier_nord';
const price = {
  object: 'price',
  id: 'price_team_fixture',
  livemode: false,
  type: 'recurring',
  recurring: { usage_type: 'licensed' },
};
const item = { object: 'subscription_item', subscription: subscriptionId, price, quantity: 18 };
const current = {
  object: 'subscription',
  id: subscriptionId,
  customer: customerId,
  livemode: false,
  status: 'active',
  cancel_at: null,
  cancel_at_period_end: false,
  pause_collection: null,
  items: { object: 'list', has_more: false, data: [item] },
};

function provider(liveMode: boolean = false) {
  return createStripeSubscriptionProvider('fixture-credential-placeholder', liveMode);
}

describe('Stripe subscription provider', () => {
  beforeEach(() => {
    sdk.configure.mockReset();
    sdk.retrieve.mockReset();
  });

  it('reads the bound subscription once through the SDK defaults and returns only seat evidence', async () => {
    sdk.retrieve.mockResolvedValue({ ...current, metadata: { note: 'synthetic provider data' } });

    await expect(provider().retrieve(subscriptionId)).resolves.toEqual({
      customerId,
      subscriptionId,
      liveMode: false,
      status: 'active',
      scheduledCancellation: false,
      collectionPaused: false,
      hasMoreItems: false,
      items: [{ priceId: price.id, quantity: 18 }],
    });
    expect(sdk.configure).toHaveBeenCalledExactlyOnceWith({
      timeout: 5_000,
      maxNetworkRetries: 0,
      telemetry: false,
    });
    expect(sdk.retrieve).toHaveBeenCalledExactlyOnceWith(subscriptionId);
  });

  it('retains the expanded customer and same-mode price only as normalized identifiers', async () => {
    sdk.retrieve.mockResolvedValue({
      ...current,
      livemode: true,
      customer: { object: 'customer', id: customerId, livemode: true },
      items: { ...current.items, data: [{ ...item, price: { ...price, livemode: true } }] },
    });

    await expect(provider(true).retrieve(subscriptionId)).resolves.toMatchObject({
      customerId,
      liveMode: true,
      items: [{ priceId: price.id, quantity: 18 }],
    });
  });

  it.each([{ cancel_at: 1_900_000_000 }, { cancel_at_period_end: true }])(
    'preserves scheduled cancellation evidence',
    async (cancellation) => {
      sdk.retrieve.mockResolvedValue({ ...current, ...cancellation });
      await expect(provider().retrieve(subscriptionId)).resolves.toMatchObject({
        scheduledCancellation: true,
      });
    },
  );

  it('preserves a collection pause even when Stripe still reports an active subscription', async () => {
    sdk.retrieve.mockResolvedValue({
      ...current,
      pause_collection: { behavior: 'keep_as_draft', resumes_at: null },
    });
    await expect(provider().retrieve(subscriptionId)).resolves.toMatchObject({
      status: 'active',
      collectionPaused: true,
    });
  });

  it.each([
    { has_more: true, data: [item] },
    { has_more: false, data: [item, item] },
    { has_more: false, data: [] },
  ])('withholds seat evidence when a single complete item is unavailable', async (items) => {
    sdk.retrieve.mockResolvedValue({ ...current, items: { object: 'list', ...items } });
    await expect(provider().retrieve(subscriptionId)).resolves.toMatchObject({
      hasMoreItems: items.has_more,
      items: [],
    });
    expect(sdk.retrieve).toHaveBeenCalledTimes(1);
  });

  it.each([
    { value: { ...item, quantity: undefined }, observation: { priceId: price.id, quantity: null } },
    {
      value: { ...item, price: { ...price, id: 'price_unconfigured_fixture' } },
      observation: { priceId: 'price_unconfigured_fixture', quantity: 18 },
    },
  ])('leaves unknown prices and missing quantities to the reconciliation policy', async (seat) => {
    sdk.retrieve.mockResolvedValue({ ...current, items: { ...current.items, data: [seat.value] } });
    const subscription = await provider().retrieve(subscriptionId);
    expect(subscription.items).toEqual([seat.observation]);
    expect(
      resolveStripeSubscription({
        subscription,
        binding: { customerId, subscriptionId },
        settings: {
          liveMode: false,
          teamPriceIds: [price.id],
          freePlanLimits: { seats: 5, storageBytes: 2_000_000_000 },
        },
      }),
    ).toEqual({ kind: 'reconcile', reason: 'unexpected-team-items' });
  });

  it.each(['', 'sub_other/another', 'sub_example%2fextra', `sub_${'x'.repeat(256)}`])(
    'refuses an invalid subscription identifier before contacting Stripe',
    async (id) => {
      await expect(provider().retrieve(id)).rejects.toThrow(
        'Current Stripe subscription evidence is unavailable.',
      );
      expect(sdk.retrieve).not.toHaveBeenCalled();
    },
  );

  it.each([
    { id: 'sub_other' },
    { livemode: true },
    { customer: { object: 'customer', id: customerId, deleted: true } },
    { customer: { object: 'customer', id: customerId, livemode: true } },
    { on_behalf_of: 'acct_other_fixture' },
    { customer_account: 'acct_other_fixture' },
    { transfer_data: { destination: 'acct_other_fixture' } },
    { application: 'ca_other_fixture' },
    { account: 'acct_other_fixture' },
    { context: 'acct_other_fixture' },
    { pause_collection: undefined },
  ])('treats inconsistent subscription evidence as unavailable', async (patch) => {
    sdk.retrieve.mockResolvedValue({ ...current, ...patch });
    await expect(provider().retrieve(subscriptionId)).rejects.toThrow(
      'Current Stripe subscription evidence is unavailable.',
    );
  });

  it.each([
    { subscription: 'sub_other' },
    { quantity: 0 },
    { quantity: 1.5 },
    { quantity: Number.MAX_SAFE_INTEGER + 1 },
    { deleted: true },
    { price: { ...price, livemode: true } },
    { price: { ...price, type: 'one_time', recurring: null } },
    { price: { ...price, recurring: { usage_type: 'metered' } } },
  ])('refuses to derive seat evidence from an invalid or incompatible item', async (patch) => {
    sdk.retrieve.mockResolvedValue({
      ...current,
      items: { ...current.items, data: [{ ...item, ...patch }] },
    });
    await expect(provider().retrieve(subscriptionId)).rejects.toThrow(
      'Current Stripe subscription evidence is unavailable.',
    );
  });

  it('returns a generic failure without the upstream Stripe error or an SDK retry', async () => {
    sdk.retrieve.mockRejectedValue(new Error('synthetic upstream error detail'));

    const result = provider().retrieve(subscriptionId);
    await expect(result).rejects.toThrow('Current Stripe subscription evidence is unavailable.');
    await expect(result.catch((error: unknown) => error)).resolves.not.toHaveProperty('cause');
    expect(sdk.retrieve).toHaveBeenCalledTimes(1);
  });
});
