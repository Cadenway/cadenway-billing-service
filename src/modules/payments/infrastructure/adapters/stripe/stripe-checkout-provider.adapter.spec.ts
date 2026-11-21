import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CheckoutProviderRequest } from '../../../application/models/checkout/checkout-provider-request.model.js';
import type { CheckoutRecoveryTarget } from '../../../application/models/checkout/checkout-recovery-target.model.js';
import {
  createStripeCheckoutProvider,
  createStripeCheckoutSessionReader,
} from './stripe-checkout-provider.adapter.js';

const sdk = vi.hoisted(() => ({
  configure: vi.fn<(options: unknown) => void>(),
  create: vi.fn<(input: unknown, options: unknown) => Promise<unknown>>(),
  list: vi.fn<(input: unknown, options: unknown) => Promise<unknown>>(),
  retrieve: vi.fn<(id: string, input: unknown, options?: unknown) => Promise<unknown>>(),
}));

vi.mock('stripe', () => ({
  default: class {
    // #region Properties
    /** Exposes the network operations through synthetic responses. */
    public readonly checkout = {
      sessions: { create: sdk.create, list: sdk.list, retrieve: sdk.retrieve },
    };
    // #endregion

    // #region Constructor
    /** Observes the transport policies without retaining the credential. */
    public constructor(_credential: string, options: unknown) {
      sdk.configure(options);
    }
    // #endregion
  },
}));

const nowSeconds = Math.floor(Date.now() / 1_000);
const expiresAt = nowSeconds + 2 * 60 * 60;
const request: CheckoutProviderRequest = {
  organizationId: 'tenant_fixture',
  providerKey: 'checkout_fixture',
  priceId: 'price_team_fixture',
  quantity: 5,
  expiresAt,
  successUrl: 'https://app.example.test/billing?checkout=success',
  cancelUrl: 'https://app.example.test/billing?checkout=cancel',
};
const opened = {
  object: 'checkout.session',
  id: 'cs_test_fixture',
  livemode: false,
  mode: 'subscription',
  status: 'open',
  client_reference_id: request.providerKey,
  metadata: { cadenway_checkout_key: request.providerKey },
  expires_at: expiresAt,
  url: 'https://checkout.stripe.com/c/pay/cs_test_fixture#stripe_credentials',
};
const seatItem = {
  object: 'item',
  currency: 'eur',
  quantity: request.quantity,
  price: {
    object: 'price',
    id: request.priceId,
    livemode: false,
    currency: 'eur',
    type: 'recurring',
    recurring: { usage_type: 'licensed' },
  },
};
const paid = {
  ...opened,
  status: 'complete',
  payment_status: 'paid',
  currency: 'eur',
  customer: 'cus_fixture',
  subscription: 'sub_fixture',
  line_items: { object: 'list', has_more: false, data: [seatItem] },
};
const currentOpen = {
  ...paid,
  status: 'open',
  payment_status: 'unpaid',
  customer: null,
  subscription: null,
};
const expired = { ...currentOpen, status: 'expired', url: null };
const target: CheckoutRecoveryTarget = {
  organizationId: request.organizationId,
  providerKey: request.providerKey,
  providerStartedAt: new Date((nowSeconds - 10) * 1_000),
  sessionId: opened.id,
  priceId: request.priceId,
  quantity: request.quantity,
  expiresAt,
};
const credential = 'test-key-placeholder';
const unavailable = 'Stripe Checkout evidence is unavailable.';

beforeEach(() => {
  sdk.configure.mockClear();
  sdk.create.mockReset();
  sdk.list.mockReset();
  sdk.retrieve.mockReset();
});

describe('Stripe hosted Checkout creation', () => {
  it('uses the committed Stripe key and parameters on every provider attempt', async () => {
    sdk.create.mockRejectedValueOnce(new Error('sensitive Stripe provider error'));
    sdk.create.mockResolvedValueOnce(opened);
    const provider = createStripeCheckoutProvider(credential, false);

    await expect(provider.create(request)).rejects.toThrow(unavailable);
    await expect(provider.create(request)).resolves.toEqual({
      url: opened.url,
      sessionId: opened.id,
    });
    const expected = {
      mode: 'subscription',
      currency: 'eur',
      adaptive_pricing: { enabled: false },
      after_expiration: { recovery: { enabled: false } },
      allowed_payment_method_types: ['card'],
      ui_mode: 'hosted_page',
      line_items: [{ price: request.priceId, quantity: request.quantity }],
      client_reference_id: request.providerKey,
      metadata: { cadenway_checkout_key: request.providerKey },
      expires_at: expiresAt,
      success_url: request.successUrl,
      cancel_url: request.cancelUrl,
    };
    expect(sdk.create.mock.calls).toEqual([
      [expected, { idempotencyKey: request.providerKey }],
      [expected, { idempotencyKey: request.providerKey }],
    ]);
    expect(sdk.configure).toHaveBeenCalledWith({
      timeout: 5_000,
      maxNetworkRetries: 0,
      telemetry: false,
    });
  });

  it.each([
    { status: 'complete' },
    { livemode: true },
    { mode: 'payment' },
    { client_reference_id: 'checkout_different' },
    { metadata: { cadenway_checkout_key: 'checkout_different' } },
    { expires_at: expiresAt + 60 },
    { after_expiration: { recovery: { enabled: true, url: null } } },
    { url: 'http://checkout.stripe.com/session' },
    { url: 'https://checkout.stripe.com.evil.example/session' },
    { url: 'https://other.example.test@checkout.stripe.com/session' },
  ])('refuses a response with invalid hosted Checkout evidence %j', async (response) => {
    sdk.create.mockResolvedValueOnce({ ...opened, ...response });
    const provider = createStripeCheckoutProvider(credential, false);
    await expect(provider.create(request)).rejects.toThrow(unavailable);
  });

  it('refuses invalid persisted parameters and unsafe deadlines before sending a request', async () => {
    const provider = createStripeCheckoutProvider(credential, false);
    await expect(provider.create({ ...request, quantity: 0 })).rejects.toThrow(unavailable);
    const legacy = {
      organizationId: request.organizationId,
      providerKey: request.providerKey,
      priceId: request.priceId,
      quantity: request.quantity,
      successUrl: request.successUrl,
      cancelUrl: request.cancelUrl,
    };
    await expect(provider.create(legacy)).rejects.toThrow(unavailable);
    await expect(provider.create({ ...request, expiresAt: nowSeconds + 30 * 60 })).rejects.toThrow(
      unavailable,
    );
    await expect(
      provider.create({ ...request, expiresAt: nowSeconds + 25 * 60 * 60 }),
    ).rejects.toThrow(unavailable);
    expect(sdk.create).not.toHaveBeenCalled();
  });
});

describe('Stripe Checkout read-only recovery', () => {
  it('reads the saved session directly and returns its original hosted URL when open', async () => {
    sdk.retrieve.mockResolvedValueOnce(currentOpen);
    const provider = createStripeCheckoutProvider(credential, false);

    await expect(provider.recover(target)).resolves.toEqual({
      status: 'open',
      sessionId: opened.id,
      url: opened.url,
    });
    expect(sdk.retrieve).toHaveBeenCalledExactlyOnceWith(
      opened.id,
      { expand: ['line_items'] },
      { timeout: expect.any(Number) as unknown },
    );
    expect(sdk.list).not.toHaveBeenCalled();
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it('finds a lost provider response through a bounded scan and confirms it via retrieval', async () => {
    const unrelated = {
      ...opened,
      id: 'cs_test_unrelated',
      client_reference_id: null,
      metadata: null,
    };
    sdk.list
      .mockResolvedValueOnce({ object: 'list', has_more: true, data: [unrelated] })
      .mockResolvedValueOnce({ object: 'list', has_more: false, data: [opened] });
    sdk.retrieve.mockResolvedValueOnce(paid);
    const provider = createStripeCheckoutProvider(credential, false);

    await expect(provider.recover({ ...target, sessionId: null })).resolves.toEqual({
      status: 'terminal',
      sessionId: opened.id,
    });
    const created = {
      gte: nowSeconds - 310,
      lte: expect.any(Number) as unknown,
    };
    expect(sdk.list).toHaveBeenNthCalledWith(
      1,
      { created, limit: 100 },
      { timeout: expect.any(Number) as unknown },
    );
    expect(sdk.list).toHaveBeenNthCalledWith(
      2,
      { created, limit: 100, starting_after: unrelated.id },
      { timeout: expect.any(Number) as unknown },
    );
    expect(sdk.retrieve).toHaveBeenCalledTimes(1);
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it('recognizes a verified expiration without creating a replacement', async () => {
    sdk.retrieve.mockResolvedValueOnce(expired);
    const provider = createStripeCheckoutProvider(credential, false);
    await expect(provider.recover(target)).resolves.toEqual({
      status: 'terminal',
      sessionId: opened.id,
    });
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it.each([
    { hasOlderMatch: false, result: { status: 'terminal', sessionId: opened.id } },
    { hasOlderMatch: true, result: { status: 'unknown' } },
  ])(
    'scans late legacy submissions and preserves ambiguity %#',
    async ({ hasOlderMatch, result }) => {
      const startedAt = nowSeconds - 2 * 24 * 60 * 60;
      const lateSession = { ...opened, created: nowSeconds - 60 };
      const earlierSession = { ...opened, id: 'cs_test_earlier', created: startedAt };
      sdk.list.mockResolvedValueOnce({
        object: 'list',
        has_more: false,
        data: hasOlderMatch ? [lateSession, earlierSession] : [lateSession],
      });
      sdk.retrieve.mockResolvedValueOnce(expired);
      const clock = vi.spyOn(Date, 'now').mockReturnValue(nowSeconds * 1_000);
      const provider = createStripeCheckoutProvider(credential, false);
      try {
        await expect(
          provider.recover({
            ...target,
            providerStartedAt: new Date(startedAt * 1_000),
            sessionId: null,
            expiresAt: undefined,
          }),
        ).resolves.toEqual(result);
        expect(sdk.list).toHaveBeenCalledExactlyOnceWith(
          { limit: 100, created: { gte: startedAt - 300, lte: nowSeconds + 300 } },
          { timeout: expect.any(Number) as unknown },
        );
        expect(sdk.retrieve).toHaveBeenCalledTimes(hasOlderMatch ? 0 : 1);
        expect(sdk.create).not.toHaveBeenCalled();
      } finally {
        clock.mockRestore();
      }
    },
  );

  it.each([
    { ...currentOpen, status: 'complete' },
    { ...expired, payment_status: 'paid' },
    { ...expired, subscription: 'sub_fixture' },
    { ...expired, after_expiration: { recovery: { enabled: true, url: null } } },
    {
      ...expired,
      after_expiration: {
        recovery: { enabled: false, url: 'https://checkout.stripe.com/recover/fixture' },
      },
    },
    { ...currentOpen, expires_at: nowSeconds - 60 },
    { ...currentOpen, expires_at: expiresAt + 60 },
    { ...currentOpen, recovered_from: 'cs_test_distinct' },
    { ...currentOpen, url: 'https://unknown.example.test/checkout' },
    { ...currentOpen, metadata: { cadenway_checkout_key: 'checkout_different' } },
    { ...currentOpen, line_items: { ...paid.line_items, data: [{ ...seatItem, quantity: 2 }] } },
    { ...paid, line_items: { ...paid.line_items, data: [{ ...seatItem, quantity: 2 }] } },
  ])(
    'keeps the attempt reserved with invalid or inconclusive canonical evidence %#',
    async (response) => {
      sdk.retrieve.mockResolvedValueOnce(response);
      const provider = createStripeCheckoutProvider(credential, false);
      await expect(provider.recover(target)).resolves.toEqual({ status: 'unknown' });
      expect(sdk.create).not.toHaveBeenCalled();
    },
  );

  it.each([
    { object: 'list', has_more: false, data: [] },
    { object: 'list', has_more: true, data: [] },
    { object: 'list', has_more: false, data: [{ ...opened, metadata: null }] },
    { object: 'list', has_more: false, data: [{ ...opened, livemode: true }] },
    { object: 'list', has_more: false, data: [opened, { ...opened, id: 'cs_test_duplicate' }] },
  ])('keeps the reservation for missing or ambiguous listing evidence %#', async (response) => {
    sdk.list.mockResolvedValueOnce(response);
    const provider = createStripeCheckoutProvider(credential, false);
    await expect(provider.recover({ ...target, sessionId: null })).resolves.toEqual({
      status: 'unknown',
    });
    expect(sdk.retrieve).not.toHaveBeenCalled();
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it('stops scanning at the page cap even after finding a candidate', async () => {
    sdk.list.mockResolvedValueOnce({ object: 'list', has_more: true, data: [opened] });
    for (let index = 0; index < 3; index += 1) {
      sdk.list.mockResolvedValueOnce({
        object: 'list',
        has_more: true,
        data: [
          {
            ...opened,
            id: `cs_test_${index.toString()}`,
            client_reference_id: null,
            metadata: {},
          },
        ],
      });
    }
    const provider = createStripeCheckoutProvider(credential, false);
    await expect(provider.recover({ ...target, sessionId: null })).resolves.toEqual({
      status: 'unknown',
    });
    expect(sdk.list).toHaveBeenCalledTimes(4);
    expect(sdk.retrieve).not.toHaveBeenCalled();
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it('keeps a known attempt reserved after a provider error', async () => {
    sdk.retrieve.mockRejectedValueOnce({ statusCode: 404, message: 'sensitive details' });
    const provider = createStripeCheckoutProvider(credential, false);
    await expect(provider.recover(target)).resolves.toEqual({ status: 'unknown' });
    expect(sdk.list).not.toHaveBeenCalled();
    expect(sdk.create).not.toHaveBeenCalled();
  });
});

describe('Stripe canonical Checkout session retrieval', () => {
  it('derives paid completion from one licensed Team seat item', async () => {
    sdk.retrieve.mockResolvedValueOnce(paid);
    const reader = createStripeCheckoutSessionReader(credential, false);
    await expect(reader.retrieve(opened.id)).resolves.toEqual({
      status: 'complete',
      sessionId: opened.id,
      providerKey: request.providerKey,
      liveMode: false,
      customerId: paid.customer,
      subscriptionId: paid.subscription,
      priceId: request.priceId,
      quantity: request.quantity,
    });
    expect(sdk.retrieve).toHaveBeenCalledExactlyOnceWith(opened.id, { expand: ['line_items'] });
  });

  it('distinguishes current expiration from unpaid Checkout states', async () => {
    const unpaid = { ...paid, payment_status: 'unpaid', subscription: null };
    sdk.retrieve
      .mockResolvedValueOnce({ ...unpaid, status: 'expired' })
      .mockResolvedValueOnce({ ...unpaid, status: 'open' })
      .mockResolvedValueOnce({ ...unpaid, status: 'complete' })
      .mockResolvedValueOnce({ ...paid, payment_status: 'no_payment_required' });
    const reader = createStripeCheckoutSessionReader(credential, false);
    await expect(reader.retrieve(opened.id)).resolves.toEqual({
      status: 'expired',
      sessionId: opened.id,
      providerKey: request.providerKey,
      liveMode: false,
    });
    await expect(reader.retrieve(opened.id)).resolves.toEqual({ status: 'pending' });
    await expect(reader.retrieve(opened.id)).resolves.toEqual({ status: 'pending' });
    await expect(reader.retrieve(opened.id)).resolves.toEqual({ status: 'pending' });
  });

  it.each([
    { id: 'cs_test_different' },
    { livemode: true },
    { mode: 'setup' },
    { client_reference_id: 'checkout_different' },
    { status: 'expired' },
    { after_expiration: { recovery: { enabled: true, url: null } } },
    { currency: 'usd' },
    { customer: null },
    { subscription: null },
    { line_items: { ...paid.line_items, has_more: true } },
    { line_items: { ...paid.line_items, data: [seatItem, seatItem] } },
    { line_items: { ...paid.line_items, data: [{ ...seatItem, quantity: 0 }] } },
    { line_items: { ...paid.line_items, data: [{ ...seatItem, currency: 'usd' }] } },
    {
      line_items: {
        ...paid.line_items,
        data: [{ ...seatItem, price: { ...seatItem.price, livemode: true } }],
      },
    },
  ])('refuses contradictory canonical evidence %j', async (response) => {
    sdk.retrieve.mockResolvedValueOnce({ ...paid, ...response });
    const reader = createStripeCheckoutSessionReader(credential, false);
    await expect(reader.retrieve(opened.id)).rejects.toThrow(unavailable);
  });
});
