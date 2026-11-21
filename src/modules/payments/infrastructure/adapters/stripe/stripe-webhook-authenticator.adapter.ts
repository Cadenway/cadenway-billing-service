import { z } from 'zod';

import type { StripeWebhookAuthenticator } from '../../../application/models/subscriptions/stripe-webhook-authenticator.model.js';
import { verifyStripeWebhook } from './stripe-webhook-verifier.adapter.js';

const eventId = z
  .string()
  .max(255)
  .regex(/^evt_[A-Za-z0-9_]+$/u);
const customerId = z
  .string()
  .max(255)
  .regex(/^cus_[A-Za-z0-9_]+$/u);
const subscriptionId = z
  .string()
  .max(255)
  .regex(/^sub_[A-Za-z0-9_]+$/u);
const subscriptionEvents = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
]);

const event = z.object({
  id: eventId,
  object: z.literal('event'),
  type: z.string().min(1).max(255),
  livemode: z.boolean(),
  account: z.null().optional(),
  context: z.null().optional(),
  data: z.object({ object: z.record(z.string(), z.unknown()) }),
});

const subscription = z.object({
  object: z.literal('subscription'),
  id: subscriptionId,
  customer: z.union([
    customerId,
    z.object({ object: z.literal('customer'), id: customerId }).transform((value) => value.id),
  ]),
});

/** Authenticates original bytes before narrowing the single-account Stripe event envelope. */
export function createStripeWebhookAuthenticator(
  liveMode: boolean,
  endpointSecrets: readonly string[],
): StripeWebhookAuthenticator {
  return (rawBody, signature) => {
    const result = verifyStripeWebhook(rawBody, signature, endpointSecrets);
    if (result.kind !== 'verified') return result;

    const envelope = event.safeParse(result.event);
    if (!envelope.success || envelope.data.livemode !== liveMode) {
      return { kind: 'invalid-event' };
    }
    if (!subscriptionEvents.has(envelope.data.type)) return { kind: 'ignored' };

    const target = subscription.safeParse(envelope.data.data.object);
    if (!target.success) return { kind: 'invalid-event' };
    return {
      kind: 'subscription',
      eventId: envelope.data.id,
      customerId: target.data.customer,
      subscriptionId: target.data.id,
    };
  };
}
