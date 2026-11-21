import Stripe from 'stripe';
import { z } from 'zod';

import type { StripeSubscriptionProvider } from '../../../application/ports/outbound/providers/subscriptions/stripe-subscription-provider.port.js';

type SubscriptionObservation = Awaited<ReturnType<StripeSubscriptionProvider['retrieve']>>;

const requestTimeoutMs = 5_000;
const subscriptionId = z
  .string()
  .max(255)
  .regex(/^sub_[A-Za-z0-9_]+$/u);
const customerId = z
  .string()
  .max(255)
  .regex(/^cus_[A-Za-z0-9_]+$/u);
const priceId = z
  .string()
  .max(255)
  .regex(/^price_[A-Za-z0-9_]+$/u);

const subscription = z.object({
  object: z.literal('subscription'),
  id: subscriptionId,
  customer: z.union([
    customerId,
    z.object({
      object: z.literal('customer'),
      id: customerId,
      deleted: z.literal(false).optional(),
      livemode: z.boolean(),
    }),
  ]),
  livemode: z.boolean(),
  status: z.string().min(1).max(64),
  cancel_at: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  cancel_at_period_end: z.boolean(),
  pause_collection: z
    .object({ behavior: z.enum(['keep_as_draft', 'mark_uncollectible', 'void']) })
    .nullable(),
  account: z.null().optional(),
  application: z.null().optional(),
  context: z.null().optional(),
  customer_account: z.null().optional(),
  on_behalf_of: z.null().optional(),
  transfer_data: z.null().optional(),
  items: z.object({
    object: z.literal('list'),
    has_more: z.boolean(),
    data: z.custom<readonly unknown[]>(Array.isArray),
  }),
});

const seatItem = z.object({
  object: z.literal('subscription_item'),
  deleted: z.literal(false).optional(),
  subscription: subscriptionId,
  quantity: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullish(),
  price: z.object({
    object: z.literal('price'),
    deleted: z.literal(false).optional(),
    id: priceId,
    livemode: z.boolean(),
    type: z.literal('recurring'),
    recurring: z.object({ usage_type: z.literal('licensed') }),
  }),
});

/** Reads the current subscription from the configured Stripe account with the SDK's API version. */
export function createStripeSubscriptionProvider(
  apiKey: string,
  liveMode: boolean,
): StripeSubscriptionProvider {
  const stripe = new Stripe(apiKey, {
    timeout: requestTimeoutMs,
    maxNetworkRetries: 0,
    telemetry: false,
  });

  return {
    async retrieve(id: string): Promise<SubscriptionObservation> {
      if (!subscriptionId.safeParse(id).success) throw unavailable();

      let response: unknown;
      try {
        response = await stripe.subscriptions.retrieve(id);
      } catch {
        // Stripe errors can carry request headers and provider response data.
        throw unavailable();
      }
      return readSubscription(response, id, liveMode);
    },
  };
}

function readSubscription(
  response: unknown,
  id: string,
  liveMode: boolean,
): SubscriptionObservation {
  const decoded = subscription.safeParse(response);
  if (!decoded.success || decoded.data.id !== id || decoded.data.livemode !== liveMode) {
    throw unavailable();
  }

  const value = decoded.data;
  const customer = value.customer;
  if (typeof customer !== 'string' && customer.livemode !== liveMode) throw unavailable();

  return {
    customerId: typeof customer === 'string' ? customer : customer.id,
    subscriptionId: value.id,
    liveMode: value.livemode,
    status: value.status,
    scheduledCancellation: value.cancel_at_period_end || value.cancel_at !== null,
    collectionPaused: value.pause_collection !== null,
    hasMoreItems: value.items.has_more,
    items: readSeatItem(value.items, id, liveMode),
  };
}

function readSeatItem(
  items: { readonly has_more: boolean; readonly data: readonly unknown[] },
  id: string,
  liveMode: boolean,
): SubscriptionObservation['items'] {
  // An incomplete list or more than one item cannot prove the single Team seat price.
  if (items.has_more || items.data.length !== 1) return [];

  const decoded = seatItem.safeParse(items.data[0]);
  if (
    !decoded.success ||
    decoded.data.subscription !== id ||
    decoded.data.price.livemode !== liveMode
  ) {
    throw unavailable();
  }

  // The domain compares the observed price with the configured Team price IDs.
  return [{ priceId: decoded.data.price.id, quantity: decoded.data.quantity ?? null }];
}

function unavailable(): Error {
  return new Error('Current Stripe subscription evidence is unavailable.');
}
