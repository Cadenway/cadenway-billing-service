import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

const maxSafeInteger = sql.raw('9007199254740991');

/** Tenant lock and pointers for the published and rebuilding usage projections. */
export const usageOrganizations = pgTable(
  'usage_organizations',
  {
    organizationId: uuid('organization_id').primaryKey(),
    activeGenerationId: uuid('active_generation_id'),
    candidateGenerationId: uuid('candidate_generation_id'),
    seatsEventVersion: bigint('seats_event_version', { mode: 'number' }).notNull().default(0),
    storageEventVersion: bigint('storage_event_version', { mode: 'number' }).notNull().default(0),
    version: bigint('version', { mode: 'number' }).notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'usage_organizations_seats_event_version_check',
      sql`${table.seatsEventVersion} between 0 and ${maxSafeInteger}`,
    ),
    check(
      'usage_organizations_storage_event_version_check',
      sql`${table.storageEventVersion} between 0 and ${maxSafeInteger}`,
    ),
    check(
      'usage_organizations_version_check',
      sql`${table.version} between 1 and ${maxSafeInteger}`,
    ),
    check(
      'usage_organizations_generations_distinct_check',
      sql`${table.activeGenerationId} is null or ${table.candidateGenerationId} is null or ${table.activeGenerationId} <> ${table.candidateGenerationId}`,
    ),
    pgPolicy('usage_organizations_tenant_isolation', {
      using: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on'`,
      withCheck: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on'`,
    }),
  ],
).enableRLS();

/** One bounded reconstruction and its accumulated usage for an organization. */
export const usageGenerations = pgTable(
  'usage_generations',
  {
    organizationId: uuid('organization_id').notNull(),
    id: uuid('id')
      .notNull()
      .default(sql`uuidv7()`),
    status: text('status').notNull().default('building'),
    seats: bigint('seats', { mode: 'number' }).notNull().default(0),
    guests: bigint('guests', { mode: 'number' }).notNull().default(0),
    storageBytes: bigint('storage_bytes', { mode: 'number' }).notNull().default(0),
    membershipCursor: text('membership_cursor'),
    membershipScanComplete: boolean('membership_scan_complete').notNull().default(false),
    attachmentCursor: text('attachment_cursor'),
    attachmentScanComplete: boolean('attachment_scan_complete').notNull().default(false),
    checkpointVersion: integer('checkpoint_version').notNull().default(1),
    streamCheckpoint: jsonb('stream_checkpoint'),
    startAdvisory: jsonb('start_advisory'),
    certifiedAdvisory: jsonb('certified_advisory'),
    version: bigint('version', { mode: 'number' }).notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [usageOrganizations.organizationId],
      name: 'usage_generations_organization_fk',
    }),
    check(
      'usage_generations_status_check',
      sql`${table.status} in ('building', 'ready', 'invalid')`,
    ),
    check('usage_generations_seats_check', sql`${table.seats} between 0 and ${maxSafeInteger}`),
    check('usage_generations_guests_check', sql`${table.guests} between 0 and ${maxSafeInteger}`),
    check(
      'usage_generations_storage_bytes_check',
      sql`${table.storageBytes} between 0 and ${maxSafeInteger}`,
    ),
    check('usage_generations_checkpoint_version_check', sql`${table.checkpointVersion} > 0`),
    check(
      'usage_generations_checkpoint_object_check',
      sql`${table.streamCheckpoint} is null or jsonb_typeof(${table.streamCheckpoint}) = 'object'`,
    ),
    check(
      'usage_generations_ready_checkpoint_check',
      sql`${table.status} <> 'ready' or (${table.membershipScanComplete} and ${table.attachmentScanComplete} and ${table.streamCheckpoint} is not null)`,
    ),
    check(
      'usage_generations_membership_cursor_check',
      sql`${table.membershipCursor} is null or length(${table.membershipCursor}) between 1 and 1024`,
    ),
    check(
      'usage_generations_attachment_cursor_check',
      sql`${table.attachmentCursor} is null or length(${table.attachmentCursor}) between 1 and 1024`,
    ),
    check('usage_generations_version_check', sql`${table.version} between 1 and ${maxSafeInteger}`),
    pgPolicy('usage_generations_tenant_isolation', {
      using: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on'`,
      withCheck: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on'`,
    }),
  ],
).enableRLS();

/** A pending threshold crossing held until the active generation's delivery is verified. */
export const usageThresholdIntents = pgTable(
  'usage_threshold_intents',
  {
    organizationId: uuid('organization_id').notNull(),
    metric: text('metric').notNull(),
    generationId: uuid('generation_id').notNull(),
    eventVersion: bigint('event_version', { mode: 'number' }).notNull(),
    quotaLimit: bigint('quota_limit', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.metric] }),
    foreignKey({
      columns: [table.organizationId, table.generationId],
      foreignColumns: [usageGenerations.organizationId, usageGenerations.id],
      name: 'usage_threshold_intents_generation_fk',
    }),
    check('usage_threshold_intents_metric_check', sql`${table.metric} in ('seats', 'storage')`),
    check(
      'usage_threshold_intents_event_version_check',
      sql`${table.eventVersion} between 1 and ${maxSafeInteger}`,
    ),
    check(
      'usage_threshold_intents_quota_limit_check',
      sql`${table.quotaLimit} between 1 and ${maxSafeInteger}`,
    ),
    pgPolicy('usage_threshold_intents_tenant_isolation', {
      using: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on'`,
      withCheck: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on'`,
    }),
  ],
).enableRLS();

/** Current source observation, including terminal removals, in a usage generation. */
export const usageObservations = pgTable(
  'usage_observations',
  {
    organizationId: uuid('organization_id').notNull(),
    generationId: uuid('generation_id').notNull(),
    source: text('source').notNull(),
    sourceId: uuid('source_id').notNull(),
    sourceVersion: bigint('source_version', { mode: 'number' }).notNull(),
    state: text('state').notNull(),
    membershipRole: text('membership_role'),
    attachmentBytes: bigint('attachment_bytes', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.generationId, table.source, table.sourceId],
    }),
    foreignKey({
      columns: [table.organizationId, table.generationId],
      foreignColumns: [usageGenerations.organizationId, usageGenerations.id],
      name: 'usage_observations_generation_fk',
    }),
    check(
      'usage_observations_source_version_check',
      sql`${table.sourceVersion} between 1 and ${maxSafeInteger}`,
    ),
    check(
      'usage_observations_shape_check',
      sql`(${table.source} = 'membership' and ${table.state} = 'present' and ${table.membershipRole} is not null and ${table.membershipRole} in ('owner', 'admin', 'member', 'guest') and ${table.attachmentBytes} is null) or (${table.source} = 'attachment' and ${table.state} = 'present' and ${table.membershipRole} is null and ${table.attachmentBytes} is not null and ${table.attachmentBytes} between 1 and 26214400) or (${table.source} in ('membership', 'attachment') and ${table.state} = 'absent' and ${table.membershipRole} is null and ${table.attachmentBytes} is null)`,
    ),
    pgPolicy('usage_observations_tenant_isolation', {
      using: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on'`,
      withCheck: sql`organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on'`,
    }),
  ],
).enableRLS();
