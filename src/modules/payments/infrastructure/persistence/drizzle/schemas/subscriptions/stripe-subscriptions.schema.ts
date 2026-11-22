import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const maximum = sql.raw('9007199254740991');

/** Billing's verified provider binding and monotonic reconciliation revision. */
export const stripeBindings = pgTable(
  'stripe_bindings',
  {
    organizationId: uuid('organization_id').primaryKey(),
    customerId: text('customer_id').notNull(),
    subscriptionId: text('subscription_id').notNull(),
    version: bigint('version', { mode: 'number' }).notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('stripe_bindings_customer_id_unique').on(table.customerId),
    uniqueIndex('stripe_bindings_subscription_id_unique').on(table.subscriptionId),
    check('stripe_bindings_customer_id_check', sql`length(${table.customerId}) between 1 and 255`),
    check(
      'stripe_bindings_subscription_id_check',
      sql`length(${table.subscriptionId}) between 1 and 255`,
    ),
    check('stripe_bindings_version_check', sql`${table.version} between 1 and ${maximum}`),
    pgPolicy('stripe_bindings_tenant_isolation', {
      using: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on'`,
      withCheck: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on'`,
    }),
  ],
).enableRLS();

/** Current reconciled entitlement, owned by Billing. */
export const stripeSubscriptionSnapshots = pgTable(
  'stripe_subscription_snapshots',
  {
    organizationId: uuid('organization_id').primaryKey(),
    plan: text('plan').$type<'free' | 'team'>().notNull(),
    seats: bigint('seats', { mode: 'number' }).notNull(),
    storageBytes: bigint('storage_bytes', { mode: 'number' }).notNull(),
    scheduledCancellation: boolean('scheduled_cancellation').notNull().default(false),
    version: bigint('version', { mode: 'number' }).notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [stripeBindings.organizationId],
    }),
    check('stripe_subscription_snapshots_plan_check', sql`${table.plan} in ('free', 'team')`),
    check(
      'stripe_subscription_snapshots_seats_check',
      sql`${table.seats} between 0 and ${maximum}`,
    ),
    check(
      'stripe_subscription_snapshots_storage_check',
      sql`${table.storageBytes} between 0 and ${maximum}`,
    ),
    check(
      'stripe_subscription_snapshots_version_check',
      sql`${table.version} between 1 and ${maximum}`,
    ),
    pgPolicy('stripe_subscription_snapshots_tenant_isolation', {
      using: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on'`,
      withCheck: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on'`,
    }),
  ],
).enableRLS();

/** Stripe event IDs are settled once across the configured account and isolated by tenant. */
export const stripeReconciliationReceipts = pgTable(
  'stripe_reconciliation_receipts',
  {
    organizationId: uuid('organization_id').notNull(),
    eventId: text('event_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.eventId] }),
    uniqueIndex('stripe_reconciliation_receipts_event_id_unique').on(table.eventId),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [stripeBindings.organizationId],
    }),
    check(
      'stripe_reconciliation_receipts_event_id_check',
      sql`length(${table.eventId}) between 1 and 255`,
    ),
    pgPolicy('stripe_reconciliation_receipts_tenant_isolation', {
      using: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on'`,
      withCheck: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on'`,
    }),
  ],
).enableRLS();
