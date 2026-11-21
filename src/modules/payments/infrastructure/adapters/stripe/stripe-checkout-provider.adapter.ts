import { assertNoActiveTransaction } from '@cadenway/nest-common/database';
import Stripe from 'stripe';
import { z } from 'zod';

import type { StripeCheckoutSession } from '../../../application/models/checkout/stripe-checkout-session.model.js';
import type { CheckoutProvider } from '../../../application/ports/outbound/providers/checkout/checkout-provider.port.js';
import type { StripeCheckoutSessionReader } from '../../../application/ports/outbound/providers/checkout/stripe-checkout-session-reader.port.js';

const requestTimeoutMs = 5_000;
const teamCurrency = 'eur';
const checkoutKey = z
  .string()
  .max(255)
  .regex(/^checkout_[A-Za-z0-9_-]+$/u);
const sessionId = z
  .string()
  .max(255)
  .regex(/^cs_[A-Za-z0-9_]+$/u);
const customerId = z
  .string()
  .max(255)
  .regex(/^cus_[A-Za-z0-9_]+$/u);
const subscriptionId = z
  .string()
  .max(255)
  .regex(/^sub_[A-Za-z0-9_]+$/u);
const priceId = z
  .string()
  .max(255)
  .regex(/^price_[A-Za-z0-9_]+$/u);
const quantity = z.number().int().positive();

const checkoutSession = z.object({
  object: z.literal('checkout.session'),
  id: sessionId,
  livemode: z.boolean(),
  mode: z.literal('subscription'),
  client_reference_id: checkoutKey,
  metadata: z.object({ cadenway_checkout_key: checkoutKey }),
  recovered_from: z.null().optional(),
});

const createdSession = checkoutSession.extend({
  status: z.literal('open'),
  url: z.string().max(4_096).refine(isHostedStripeUrl),
});

const currentSession = checkoutSession.extend({
  status: z.enum(['open', 'complete', 'expired']),
  payment_status: z.enum(['paid', 'unpaid', 'no_payment_required']),
  currency: z.string().nullable(),
  customer: customerId.nullable(),
  subscription: subscriptionId.nullable(),
  line_items: z.unknown(),
});

const seatItems = z.object({
  object: z.literal('list'),
  has_more: z.literal(false),
  data: z.tuple([
    z.object({
      object: z.literal('item'),
      currency: z.literal(teamCurrency),
      quantity,
      price: z.object({
        object: z.literal('price'),
        id: priceId,
        deleted: z.literal(false).optional(),
        livemode: z.boolean(),
        currency: z.literal(teamCurrency),
        type: z.literal('recurring'),
        recurring: z.object({ usage_type: z.literal('licensed') }),
      }),
    }),
  ]),
});

/** Creates a hosted Checkout using the previously committed Stripe request identity. */
export function createStripeCheckoutProvider(apiKey: string, liveMode: boolean): CheckoutProvider {
  const stripe = checkoutClient(apiKey);
  return {
    async create(request): Promise<string> {
      assertNoActiveTransaction();
      if (
        !checkoutKey.safeParse(request.providerKey).success ||
        !priceId.safeParse(request.priceId).success ||
        !quantity.safeParse(request.quantity).success
      ) {
        throw unavailable();
      }

      let response: unknown;
      try {
        response = await stripe.create(
          {
            mode: 'subscription',
            currency: teamCurrency,
            adaptive_pricing: { enabled: false },
            allowed_payment_method_types: ['card'],
            ui_mode: 'hosted_page',
            line_items: [{ price: request.priceId, quantity: request.quantity }],
            client_reference_id: request.providerKey,
            metadata: { cadenway_checkout_key: request.providerKey },
            success_url: request.successUrl,
            cancel_url: request.cancelUrl,
          },
          { idempotencyKey: request.providerKey },
        );
      } catch {
        // The provider may have created a session. Billing can only retry the same request.
        throw unavailable();
      }

      const created = createdSession.safeParse(response);
      if (
        !created.success ||
        created.data.livemode !== liveMode ||
        created.data.client_reference_id !== request.providerKey ||
        created.data.metadata.cadenway_checkout_key !== request.providerKey
      ) {
        throw unavailable();
      }
      return created.data.url;
    },
  };
}

/** Reads canonical checkout state from the same configured account after webhook admission. */
export function createStripeCheckoutSessionReader(
  apiKey: string,
  liveMode: boolean,
): StripeCheckoutSessionReader {
  const stripe = checkoutClient(apiKey);
  return {
    async retrieve(id: string): Promise<StripeCheckoutSession> {
      assertNoActiveTransaction();
      if (!sessionId.safeParse(id).success) throw unavailable();

      let response: unknown;
      try {
        response = await stripe.retrieve(id, { expand: ['line_items'] });
      } catch {
        throw unavailable();
      }
      return readSession(response, id, liveMode);
    },
  };
}

function checkoutClient(apiKey: string): Stripe['checkout']['sessions'] {
  const stripe = new Stripe(apiKey, {
    timeout: requestTimeoutMs,
    maxNetworkRetries: 0,
    telemetry: false,
  });
  return stripe.checkout.sessions;
}

function readSession(response: unknown, id: string, liveMode: boolean): StripeCheckoutSession {
  const decoded = currentSession.safeParse(response);
  if (
    !decoded.success ||
    decoded.data.id !== id ||
    decoded.data.livemode !== liveMode ||
    decoded.data.metadata.cadenway_checkout_key !== decoded.data.client_reference_id
  ) {
    throw unavailable();
  }

  const session = decoded.data;
  const reference = { sessionId: id, liveMode, providerKey: session.client_reference_id };
  if (session.status === 'expired') {
    if (session.payment_status !== 'unpaid' || session.subscription !== null) throw unavailable();
    return { status: 'expired', ...reference };
  }
  if (session.status !== 'complete' || session.payment_status !== 'paid') {
    return { status: 'pending' };
  }

  const items = seatItems.safeParse(session.line_items);
  if (
    session.currency !== teamCurrency ||
    session.customer === null ||
    session.subscription === null ||
    !items.success ||
    items.data.data[0].price.livemode !== liveMode
  ) {
    throw unavailable();
  }

  const [item] = items.data.data;
  return {
    status: 'complete',
    ...reference,
    customerId: session.customer,
    subscriptionId: session.subscription,
    priceId: item.price.id,
    quantity: item.quantity,
  };
}

function isHostedStripeUrl(value: string): boolean {
  const url = URL.parse(value);
  return (
    url?.protocol === 'https:' &&
    url.host === 'checkout.stripe.com' &&
    url.username === '' &&
    url.password === '' &&
    url.pathname.length > 1
  );
}

function unavailable(): Error {
  return new Error('Stripe Checkout evidence is unavailable.');
}
