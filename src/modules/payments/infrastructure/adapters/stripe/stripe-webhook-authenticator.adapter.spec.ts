import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createStripeWebhookAuthenticator } from './stripe-webhook-authenticator.adapter.js';

const endpointKey = 'whsec_fixture';
const authenticate = createStripeWebhookAuthenticator(false, [endpointKey]);
const subscription = { object: 'subscription', id: 'sub_fixture', customer: 'cus_fixture' };
const event = {
  id: 'evt_fixture',
  object: 'event',
  type: 'customer.subscription.updated',
  livemode: false,
  data: { object: subscription },
};

function signed(delivery: unknown): { readonly rawBody: Buffer; readonly signature: string } {
  const body = JSON.stringify(delivery);
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const digest = createHmac('sha256', endpointKey).update(`${timestamp}.${body}`).digest('hex');
  return { rawBody: Buffer.from(body), signature: `t=${timestamp},v1=${digest}` };
}

describe('Stripe webhook authentication and envelope', () => {
  it('takes the signed IDs without accepting event metadata as tenant authority', () => {
    const delivery = signed({
      ...event,
      data: { object: { ...subscription, metadata: { organizationId: 'tenant-of-choice' } } },
    });
    expect(authenticate(delivery.rawBody, delivery.signature)).toEqual({
      kind: 'subscription',
      eventId: 'evt_fixture',
      customerId: 'cus_fixture',
      subscriptionId: 'sub_fixture',
    });
  });

  it('does not admit altered bytes that still form a valid event', () => {
    const { rawBody, signature } = signed(event);
    const padded = Buffer.concat([rawBody, Buffer.from(' ')]);
    expect(authenticate(padded, signature)).toEqual({ kind: 'invalid-signature' });
  });

  it.each([
    { ...event, livemode: true },
    { ...event, account: 'acct_fixture' },
    { ...event, context: 'ctx_fixture' },
    { ...event, object: 'wrong' },
    { ...event, id: 'fake_event' },
    { ...event, data: { object: { ...subscription, id: 'cus_instead' } } },
    { ...event, data: { object: { ...subscription, customer: 'sub_instead' } } },
  ])('rejects out-of-mode, nonlocal or invalid signed event %j', (invalid) => {
    const { rawBody, signature } = signed(invalid);
    expect(authenticate(rawBody, signature)).toEqual({ kind: 'invalid-event' });
  });

  it.each([
    'checkout.session.completed',
    'checkout.session.async_payment_succeeded',
    'checkout.session.expired',
  ])('takes only the verified event and session IDs for %s', (type) => {
    const { rawBody, signature } = signed({
      ...event,
      type,
      data: {
        object: {
          object: 'checkout.session',
          id: 'cs_test_fixture',
          client_reference_id: 'checkout_untrusted',
          metadata: { organizationId: 'tenant-of-choice' },
          payment_status: 'paid',
        },
      },
    });
    expect(authenticate(rawBody, signature)).toEqual({
      kind: 'checkout',
      eventId: event.id,
      sessionId: 'cs_test_fixture',
    });
  });

  it('rejects a signed Checkout event without a well-formed session ID', () => {
    const { rawBody, signature } = signed({
      ...event,
      type: 'checkout.session.completed',
      data: { object: { object: 'checkout.session', id: 'sub_fixture' } },
    });
    expect(authenticate(rawBody, signature)).toEqual({ kind: 'invalid-event' });
  });

  it('allows inbox routing only for matching signed Checkout references', () => {
    const target = {
      object: 'checkout.session',
      id: 'cs_test_fixture',
      client_reference_id: 'checkout_known',
    };
    const checkoutEvent = { ...event, type: 'checkout.session.completed' };
    const valid = signed({
      ...checkoutEvent,
      data: { object: { ...target, metadata: { cadenway_checkout_key: 'checkout_known' } } },
    });
    const mismatch = signed({
      ...checkoutEvent,
      data: { object: { ...target, metadata: { cadenway_checkout_key: 'checkout_different' } } },
    });
    const expected = { kind: 'checkout', eventId: event.id, sessionId: target.id };
    expect(authenticate(valid.rawBody, valid.signature)).toEqual({
      ...expected,
      providerKey: 'checkout_known',
    });
    expect(authenticate(mismatch.rawBody, mismatch.signature)).toEqual(expected);
  });

  it('intentionally ignores correctly signed events outside the supported allowlists', () => {
    const { rawBody, signature } = signed({
      ...event,
      type: 'invoice.created',
      data: { object: { object: 'invoice' } },
    });
    expect(authenticate(rawBody, signature)).toEqual({ kind: 'ignored' });
  });
});
