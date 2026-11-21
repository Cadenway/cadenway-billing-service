import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** Durable reservations and replay records for hosted Stripe Checkout. */
export const stripeCheckoutAttempts = pgTable(
  'stripe_checkout_attempts',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    organizationId: uuid('organization_id').notNull(),
    actorId: uuid('actor_id').notNull(),
    keyDigest: text('key_digest').notNull(),
    plan: text('plan').notNull(),
    providerKey: text('provider_key').notNull(),
    priceId: text('price_id'),
    quantity: bigint('quantity', { mode: 'number' }),
    successUrl: text('success_url'),
    cancelUrl: text('cancel_url'),
    providerStartedAt: timestamp('provider_started_at', { withTimezone: true }),
    providerExpiresAt: bigint('provider_expires_at', { mode: 'number' }),
    providerSessionId: text('provider_session_id'),
    providerDispatchKeyDigest: text('provider_dispatch_key_digest'),
    responseUrl: text('response_url'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    leaseToken: text('lease_token'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    version: bigint('version', { mode: 'number' }).notNull().default(1),
  },
  (table) => [
    uniqueIndex('stripe_checkout_attempts_provider_key_unique').on(table.providerKey),
    uniqueIndex('stripe_checkout_attempts_provider_session_unique')
      .on(table.providerSessionId)
      .where(sql`${table.providerSessionId} is not null`),
    uniqueIndex('stripe_checkout_attempts_actor_key_unique').on(
      table.organizationId,
      table.actorId,
      table.keyDigest,
    ),
    uniqueIndex('stripe_checkout_attempts_active_organization_unique')
      .on(table.organizationId)
      .where(sql`${table.resolvedAt} is null`),
    check('stripe_checkout_attempts_key_digest_check', sql`${table.keyDigest} ~ '^[a-f0-9]{64}$'`),
    check('stripe_checkout_attempts_plan_check', sql`${table.plan} = 'team'`),
    check(
      'stripe_checkout_attempts_version_check',
      sql`${table.version} between 1 and 9007199254740991`,
    ),
    check(
      'stripe_checkout_attempts_lease_check',
      sql`(${table.leaseToken} is null) = (${table.leaseExpiresAt} is null)`,
    ),
    check(
      'stripe_checkout_attempts_request_check',
      sql`(${table.providerStartedAt} is null and ${table.priceId} is null and ${table.quantity} is null and ${table.successUrl} is null and ${table.cancelUrl} is null)
        or (${table.providerStartedAt} is not null and ${table.priceId} is not null and ${table.quantity} is not null and ${table.quantity} > 0 and ${table.successUrl} is not null and ${table.cancelUrl} is not null)`,
    ),
    check(
      'stripe_checkout_attempts_response_check',
      sql`(${table.responseUrl} is null and ${table.completedAt} is null)
        or (${table.responseUrl} is not null and ${table.completedAt} is not null
          and ${table.providerStartedAt} is not null and ${table.leaseToken} is null)`,
    ),
    check(
      'stripe_checkout_attempts_provider_expiry_check',
      sql`${table.providerExpiresAt} is null
        or (${table.providerStartedAt} is not null and ${table.providerExpiresAt} between 1 and 9007199254740991)`,
    ),
    check(
      'stripe_checkout_attempts_dispatch_key_digest_check',
      sql`${table.providerDispatchKeyDigest} is null
        or (${table.providerStartedAt} is not null and ${table.providerDispatchKeyDigest} ~ '^[a-f0-9]{64}$')`,
    ),
    check(
      'stripe_checkout_attempts_provider_session_check',
      sql`${table.providerSessionId} is null
        or (${table.providerStartedAt} is not null and ${table.providerSessionId} ~ '^cs_[A-Za-z0-9_]{1,252}$')`,
    ),
    pgPolicy('stripe_checkout_attempts_tenant_isolation', {
      using: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid`,
      withCheck: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid`,
    }),
    pgPolicy('stripe_checkout_attempts_exact_system_lookup', {
      for: 'select',
      using: sql`current_setting('app.system_access', true) = 'on'
        and provider_key = nullif(current_setting('app.stripe_checkout_provider_key', true), '')`,
    }),
  ],
).enableRLS();

/** Immutable receipt for each applied or expired Checkout event. */
export const stripeCheckoutReceipts = pgTable(
  'stripe_checkout_receipts',
  {
    organizationId: uuid('organization_id').notNull(),
    eventId: text('event_id').primaryKey(),
    providerKey: text('provider_key').notNull(),
    sessionId: text('session_id').notNull(),
    terminalStatus: text('terminal_status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('stripe_checkout_receipts_reservation').on(
      table.organizationId,
      table.providerKey,
      table.sessionId,
    ),
    check(
      'stripe_checkout_receipts_terminal_check',
      sql`${table.terminalStatus} in ('complete', 'expired')`,
    ),
    pgPolicy('stripe_checkout_receipts_tenant_isolation', {
      using: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid`,
      withCheck: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid`,
    }),
    pgPolicy('stripe_checkout_receipts_exact_system_lookup', {
      for: 'select',
      using: sql`current_setting('app.system_access', true) = 'on'
        and event_id = nullif(current_setting('app.stripe_checkout_event_id', true), '')`,
    }),
  ],
).enableRLS();
