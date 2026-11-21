import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/** Authenticated Stripe identities awaiting settlement. */
export const stripeWebhookInbox = pgTable(
  'stripe_webhook_inbox',
  {
    eventId: text('event_id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    kind: text('kind').notNull(),
    sessionId: text('session_id'),
    customerId: text('customer_id'),
    subscriptionId: text('subscription_id'),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    leaseToken: uuid('lease_token'),
    claimCount: integer('claim_count').notNull().default(0),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('stripe_webhook_inbox_pending')
      .on(table.availableAt, table.eventId)
      .where(sql`${table.finishedAt} is null`),
    check(
      'stripe_webhook_inbox_identity_check',
      sql`${table.eventId} ~ '^[!-~]{1,255}$'
        and (
          (${table.kind} = 'checkout' and ${table.sessionId} is not null
            and ${table.sessionId} ~ '^[!-~]{1,255}$'
            and ${table.customerId} is null and ${table.subscriptionId} is null)
          or (${table.kind} = 'subscription' and ${table.sessionId} is null
            and ${table.customerId} is not null and ${table.subscriptionId} is not null
            and ${table.customerId} ~ '^[!-~]{1,255}$'
            and ${table.subscriptionId} ~ '^[!-~]{1,255}$')
        )`,
    ),
    check('stripe_webhook_inbox_claim_count_check', sql`${table.claimCount} between 0 and 1000000`),
    check(
      'stripe_webhook_inbox_finished_check',
      sql`${table.finishedAt} is null or ${table.leaseToken} is null`,
    ),
    pgPolicy('stripe_webhook_inbox_tenant_isolation', {
      using: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid`,
      withCheck: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid`,
    }),
    pgPolicy('stripe_webhook_inbox_worker_select', {
      for: 'select',
      using: sql`current_setting('app.system_access', true) = 'on'
        and current_setting('app.stripe_webhook_inbox_work', true) = 'on'
        and finished_at is null`,
    }),
    pgPolicy('stripe_webhook_inbox_worker_update', {
      for: 'update',
      using: sql`current_setting('app.system_access', true) = 'on'
        and current_setting('app.stripe_webhook_inbox_work', true) = 'on'
        and finished_at is null`,
      withCheck: sql`current_setting('app.system_access', true) = 'on'
        and current_setting('app.stripe_webhook_inbox_work', true) = 'on'
        and finished_at is null`,
    }),
  ],
).enableRLS();
