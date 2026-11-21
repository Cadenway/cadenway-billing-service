import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CheckoutProviderRequest } from '../../../application/models/checkout/checkout-provider-request.model.js';
import {
  createStripeCheckoutProvider,
  createStripeCheckoutSessionReader,
} from './stripe-checkout-provider.adapter.js';

const sdk = vi.hoisted(() => ({
  configure: vi.fn<(options: unknown) => void>(),
  create: vi.fn<(input: unknown, options: unknown) => Promise<unknown>>(),
  retrieve: vi.fn<(id: string, options: unknown) => Promise<unknown>>(),
}));

vi.mock('stripe', () => ({
  default: class {
    // #region Properties
    /** Exposes the network operations through synthetic responses. */
    public readonly checkout = { sessions: { create: sdk.create, retrieve: sdk.retrieve } };
    // #endregion

    // #region Constructor
    /** Observes the transport policies without retaining the credential. */
    public constructor(_credential: string, options: unknown) {
      sdk.configure(options);
    }
    // #endregion
  },
}));

const request: CheckoutProviderRequest = {
  organizationId: 'tenant_fixture',
  providerKey: 'checkout_fixture',
  priceId: 'price_team_fixture',
  quantity: 5,
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
const credential = 'test-key-placeholder';
const unavailable = 'Stripe Checkout evidence is unavailable.';

beforeEach(() => {
  sdk.configure.mockClear();
  sdk.create.mockReset();
  sdk.retrieve.mockReset();
});

describe('Stripe hosted Checkout creation', () => {
  it('uses the committed Stripe key and parameters on every provider attempt', async () => {
    sdk.create.mockRejectedValueOnce(new Error('sensitive Stripe provider error'));
    sdk.create.mockResolvedValueOnce(opened);
    const provider = createStripeCheckoutProvider(credential, false);

    await expect(provider.create(request)).rejects.toThrow(unavailable);
    await expect(provider.create(request)).resolves.toEqual(opened.url);
    const expected = {
      mode: 'subscription',
      currency: 'eur',
      adaptive_pricing: { enabled: false },
      allowed_payment_method_types: ['card'],
      ui_mode: 'hosted_page',
      line_items: [{ price: request.priceId, quantity: request.quantity }],
      client_reference_id: request.providerKey,
      metadata: { cadenway_checkout_key: request.providerKey },
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
    { url: 'http://checkout.stripe.com/session' },
    { url: 'https://checkout.stripe.com.evil.example/session' },
    { url: 'https://other.example.test@checkout.stripe.com/session' },
  ])('refuses a response with invalid hosted Checkout evidence %j', async (response) => {
    sdk.create.mockResolvedValueOnce({ ...opened, ...response });
    const provider = createStripeCheckoutProvider(credential, false);
    await expect(provider.create(request)).rejects.toThrow(unavailable);
  });

  it('refuses invalid persisted parameters before sending a request', async () => {
    const provider = createStripeCheckoutProvider(credential, false);
    await expect(provider.create({ ...request, quantity: 0 })).rejects.toThrow(unavailable);
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
