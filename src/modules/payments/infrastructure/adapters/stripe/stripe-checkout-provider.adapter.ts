import { remainingBudgetMs } from '@cadenway/nest-common';
import { assertNoActiveTransaction } from '@cadenway/nest-common/database';
import Stripe from 'stripe';
import { z } from 'zod';

import type { CheckoutRecoveryEvidence } from '../../../application/models/checkout/checkout-recovery-evidence.model.js';
import type { CheckoutRecoveryTarget } from '../../../application/models/checkout/checkout-recovery-target.model.js';
import type { StripeCheckoutSession } from '../../../application/models/checkout/stripe-checkout-session.model.js';
import type { CheckoutProvider } from '../../../application/ports/outbound/providers/checkout/checkout-provider.port.js';
import type { StripeCheckoutSessionReader } from '../../../application/ports/outbound/providers/checkout/stripe-checkout-session-reader.port.js';

const requestTimeoutMs = 5_000;
const minimumCheckoutLifetimeMs = 30 * 60 * 1_000;
const maximumCheckoutLifetimeSeconds = 24 * 60 * 60;
const creationClockSkewSeconds = 5 * 60;
const recoveryPageSize = 100;
const recoveryMaxPages = 4;
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
const timestampSeconds = z.number().int().nonnegative();
const hostedUrl = z.string().max(4_096).refine(isHostedStripeUrl);

const checkoutSession = z.object({
  object: z.literal('checkout.session'),
  id: sessionId,
  livemode: z.boolean(),
  mode: z.literal('subscription'),
  client_reference_id: checkoutKey,
  metadata: z.object({ cadenway_checkout_key: checkoutKey }),
  recovered_from: z.null().optional(),
  after_expiration: z
    .object({
      recovery: z.object({ enabled: z.literal(false), url: z.null().optional() }).nullish(),
    })
    .nullish(),
});

const createdSession = checkoutSession.extend({
  status: z.literal('open'),
  url: hostedUrl,
  expires_at: timestampSeconds,
});

const currentSession = checkoutSession.extend({
  status: z.enum(['open', 'complete', 'expired']),
  payment_status: z.enum(['paid', 'unpaid', 'no_payment_required']),
  currency: z.string().nullable(),
  customer: customerId.nullable(),
  subscription: subscriptionId.nullable(),
  line_items: z.unknown(),
  expires_at: z.unknown(),
  url: z.unknown(),
});

const sessionPage = z.object({
  object: z.literal('list'),
  has_more: z.boolean(),
  data: z
    .array(
      z.object({
        object: z.literal('checkout.session'),
        id: sessionId,
        livemode: z.boolean(),
        client_reference_id: z.string().nullable(),
        metadata: z.object({ cadenway_checkout_key: z.string().optional() }).nullable(),
      }),
    )
    .max(recoveryPageSize),
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
    async create(request) {
      assertNoActiveTransaction();
      const { expiresAt } = request;
      if (
        !checkoutKey.safeParse(request.providerKey).success ||
        !priceId.safeParse(request.priceId).success ||
        !quantity.safeParse(request.quantity).success ||
        expiresAt === undefined ||
        !canCreateBeforeExpiry(expiresAt)
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
            after_expiration: { recovery: { enabled: false } },
            allowed_payment_method_types: ['card'],
            ui_mode: 'hosted_page',
            line_items: [{ price: request.priceId, quantity: request.quantity }],
            client_reference_id: request.providerKey,
            metadata: { cadenway_checkout_key: request.providerKey },
            expires_at: expiresAt,
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
        created.data.metadata.cadenway_checkout_key !== request.providerKey ||
        created.data.expires_at !== expiresAt
      ) {
        throw unavailable();
      }
      return { sessionId: created.data.id, url: created.data.url };
    },

    async recover(target): Promise<CheckoutRecoveryEvidence> {
      assertNoActiveTransaction();
      try {
        return await recoverSession(stripe, liveMode, target);
      } catch {
        // A missing session, a provider error and inconclusive reads all retain the reservation.
        return { status: 'unknown' };
      }
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
      return mapSession(decodeSession(response, id, liveMode));
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

function canCreateBeforeExpiry(expiresAt: number): boolean {
  const remainingMs = expiresAt * 1_000 - Date.now();
  return (
    Number.isSafeInteger(expiresAt) &&
    remainingMs > minimumCheckoutLifetimeMs + requestTimeoutMs &&
    remainingMs <= maximumCheckoutLifetimeSeconds * 1_000
  );
}

async function recoverSession(
  stripe: Stripe['checkout']['sessions'],
  liveMode: boolean,
  target: CheckoutRecoveryTarget,
): Promise<CheckoutRecoveryEvidence> {
  const deadline = performance.now() + Math.min(requestTimeoutMs, remainingBudgetMs() ?? Infinity);
  if (!checkoutKey.safeParse(target.providerKey).success) return { status: 'unknown' };
  const id = target.sessionId ?? (await locateSession(stripe, liveMode, target, deadline));
  if (id === null || !sessionId.safeParse(id).success) return { status: 'unknown' };

  const response: unknown = await stripe.retrieve(
    id,
    { expand: ['line_items'] },
    { timeout: recoveryTimeout(deadline) },
  );
  const session = decodeSession(response, id, liveMode);
  if (session.client_reference_id !== target.providerKey) return { status: 'unknown' };

  const terminal = mapSession(session);
  if (terminal.status === 'expired') return { status: 'terminal', sessionId: id };
  if (terminal.status === 'complete') {
    return terminal.priceId === target.priceId && terminal.quantity === target.quantity
      ? { status: 'terminal', sessionId: id }
      : { status: 'unknown' };
  }

  const expiry = timestampSeconds.safeParse(session.expires_at);
  const url = hostedUrl.safeParse(session.url);
  if (
    session.status !== 'open' ||
    session.payment_status !== 'unpaid' ||
    session.subscription !== null ||
    !expiry.success ||
    expiry.data * 1_000 <= Date.now() ||
    (target.expiresAt !== undefined && target.expiresAt !== expiry.data) ||
    !url.success
  ) {
    return { status: 'unknown' };
  }
  const item = readSeatItem(session);
  if (item.quantity !== target.quantity || item.price.id !== target.priceId) {
    return { status: 'unknown' };
  }
  return { status: 'open', sessionId: id, url: url.data };
}

async function locateSession(
  stripe: Stripe['checkout']['sessions'],
  liveMode: boolean,
  target: CheckoutRecoveryTarget,
  deadline: number,
): Promise<string | null> {
  const startedAt = Math.floor(target.providerStartedAt.getTime() / 1_000);
  const now = Math.floor(Date.now() / 1_000);
  // A suspended dispatcher could have sent a legacy request after the key retention window.
  const latestCreation = target.expiresAt ?? now;
  if (!Number.isSafeInteger(startedAt) || !Number.isSafeInteger(latestCreation)) return null;
  const created = {
    gte: Math.max(0, startedAt - creationClockSkewSeconds),
    lte: Math.min(now, latestCreation) + creationClockSkewSeconds,
  };
  if (created.lte < created.gte) return null;
  const visited = new Set<string>();
  let candidate: string | null = null;
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < recoveryMaxPages; pageNumber += 1) {
    const page = sessionPage.safeParse(
      await stripe.list(
        {
          limit: recoveryPageSize,
          created,
          ...(cursor === undefined ? {} : { starting_after: cursor }),
        },
        { timeout: recoveryTimeout(deadline) },
      ),
    );
    if (!page.success) return null;
    for (const entry of page.data.data) {
      if (entry.livemode !== liveMode || visited.has(entry.id)) return null;
      visited.add(entry.id);

      const referenceMatches = entry.client_reference_id === target.providerKey;
      const metadataMatches = entry.metadata?.cadenway_checkout_key === target.providerKey;
      if (!referenceMatches && !metadataMatches) continue;
      if (!referenceMatches || !metadataMatches || candidate !== null) return null;
      candidate = entry.id;
    }
    if (!page.data.has_more) return candidate;
    cursor = page.data.data.at(-1)?.id;
    if (cursor === undefined) return null;
  }
  return null;
}

function recoveryTimeout(deadline: number): number {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0) throw unavailable();
  return remaining;
}

function decodeSession(
  response: unknown,
  id: string,
  liveMode: boolean,
): z.output<typeof currentSession> {
  const decoded = currentSession.safeParse(response);
  if (
    !decoded.success ||
    decoded.data.id !== id ||
    decoded.data.livemode !== liveMode ||
    decoded.data.metadata.cadenway_checkout_key !== decoded.data.client_reference_id
  ) {
    throw unavailable();
  }
  return decoded.data;
}

function mapSession(session: z.output<typeof currentSession>): StripeCheckoutSession {
  const reference = {
    sessionId: session.id,
    liveMode: session.livemode,
    providerKey: session.client_reference_id,
  };
  if (session.status === 'expired') {
    if (session.payment_status !== 'unpaid' || session.subscription !== null) throw unavailable();
    return { status: 'expired', ...reference };
  }
  if (session.status !== 'complete' || session.payment_status !== 'paid') {
    return { status: 'pending' };
  }

  if (session.customer === null || session.subscription === null) {
    throw unavailable();
  }

  const item = readSeatItem(session);
  return {
    status: 'complete',
    ...reference,
    customerId: session.customer,
    subscriptionId: session.subscription,
    priceId: item.price.id,
    quantity: item.quantity,
  };
}

function readSeatItem(
  session: z.output<typeof currentSession>,
): z.output<typeof seatItems>['data'][0] {
  const items = seatItems.safeParse(session.line_items);
  if (
    session.currency !== teamCurrency ||
    !items.success ||
    items.data.data[0].price.livemode !== session.livemode
  ) {
    throw unavailable();
  }
  return items.data.data[0];
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
