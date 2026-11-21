import {
  baseConfigShape,
  internalTokenSignerConfigShape,
  internalTokenVerifierConfigShape,
} from '@cadenway/nest-common';
import type {
  BaseConfig,
  InternalTokenSignerConfig,
  InternalTokenVerifierConfig,
} from '@cadenway/nest-common';
import { databaseConfigShape } from '@cadenway/nest-common/database';
import type { DatabaseConfig } from '@cadenway/nest-common/database';
import { messagingConfigShape } from '@cadenway/nest-messaging';
import type { MessagingConfig } from '@cadenway/nest-messaging';
import { z } from 'zod';

/**
 * Type AppConfig
 *
 * @description
 * Variables the running service reads, validated when the application is created: by `loadConfig`
 * in `main.ts` for the options of `createApplication`, and by `ConfigModule` for the providers that
 * inject `CONFIG`.
 *
 * - `NODE_ENV`, `PORT`, `LOG_LEVEL`, `LOG_PRETTY`: `baseConfigShape` of `@cadenway/nest-common`;
 *   `PORT` is required, the others default to `production`, `info` and `false`.
 * - `DATABASE_URL`: the application role of this service's own database (`billing_app`), subject to
 *   row-level security and holding no DDL right.
 * - `DATABASE_TRANSACTION_MAX_ATTEMPTS`: total attempts for retryable PostgreSQL transactions,
 *   defaulting to 3. Use 1 to disable retries.
 * - `NATS_URL`, `NATS_USER`, `NATS_PASSWORD`: `messagingConfigShape` of `@cadenway/nest-messaging`.
 *   `NATS_URL` is required; the user (`billing`) and its password are optional for the kit, which
 *   accepts an anonymous local broker, but every broker of Cadenway refuses a connection without
 *   them.
 * - `INTERNAL_TOKEN_AUDIENCE` and `INTERNAL_TOKEN_TRUSTED_ISSUERS`: the `aud` this service accepts
 *   and the public keys of the backends allowed to call it.
 * - `BILLING_USAGE_ENABLED` enables the projection worker and retained event consumers.
 * - `BILLING_STRIPE_WEBHOOK_MODE` and `BILLING_STRIPE_WEBHOOK_SECRETS` select the verified
 *   delivery mode and active endpoint keys.
 * - `ORGANIZATION_SERVICE_URL`, `STORAGE_SERVICE_URL` and `INTERNAL_TOKEN_PRIVATE_JWK`
 *   identify and authenticate the authority reads when the worker is enabled.
 *
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is read by `telemetry.ts`, before the application exists.
 *
 */
export type AppConfig = BaseConfig &
  DatabaseConfig &
  MessagingConfig &
  InternalTokenVerifierConfig & {
    readonly BILLING_USAGE_ENABLED: boolean;
    readonly BILLING_STRIPE_WEBHOOK_MODE: 'test' | 'live';
    readonly BILLING_STRIPE_WEBHOOK_SECRETS?: readonly string[] | undefined;
    readonly ORGANIZATION_SERVICE_URL?: string | undefined;
    readonly STORAGE_SERVICE_URL?: string | undefined;
    readonly INTERNAL_TOKEN_PRIVATE_JWK?: InternalTokenSignerConfig['INTERNAL_TOKEN_PRIVATE_JWK'];
  };

/** Parses a source origin without accepting credentials or a service-specific path. */
function sourceOrigin(service: 'Organization' | 'Storage'): z.ZodType<string> {
  return z
    .url({ protocol: /^https?$/u, error: `Expected the http:// or https:// origin of ${service}.` })
    .transform((value, context) => {
      const url = new URL(value);
      if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
        context.addIssue({ code: 'custom', message: `Expected the origin of ${service}.` });
        return z.NEVER;
      }
      return url.origin;
    });
}

const stripeEndpointSecrets = z
  .string()
  .max(2_048)
  .transform((value, context) => {
    const schema = z
      .array(z.string().regex(/^whsec_[A-Za-z0-9_]{1,255}$/u))
      .min(1)
      .max(2);
    try {
      const parsed = schema.safeParse(JSON.parse(value));
      if (parsed.success) return parsed.data;
    } catch {
      // Report only the configuration name and expected shape, without the signing keys.
    }
    context.addIssue({
      code: 'custom',
      message: 'Expected one or two Stripe endpoint keys as JSON.',
    });
    return z.NEVER;
  });

/**
 * Constant appConfigSchema
 *
 * @description
 * Zod schema of `AppConfig`, composed from the shapes of `@cadenway/nest-common` and
 * `@cadenway/nest-messaging` so the names, defaults and validation stay those of the kit. A missing
 * or invalid variable makes `loadConfig` throw a `ConfigError` that names it without printing its
 * value.
 *
 * @type {z.ZodType<AppConfig>}
 */
export const appConfigSchema: z.ZodType<AppConfig> = z
  .object({
    ...baseConfigShape,
    ...databaseConfigShape,
    ...messagingConfigShape,
    ...internalTokenVerifierConfigShape,
    BILLING_STRIPE_WEBHOOK_MODE: z.enum(['test', 'live']).default('test'),
    BILLING_STRIPE_WEBHOOK_SECRETS: stripeEndpointSecrets.optional(),
    BILLING_USAGE_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    ORGANIZATION_SERVICE_URL: sourceOrigin('Organization').optional(),
    STORAGE_SERVICE_URL: sourceOrigin('Storage').optional(),
    INTERNAL_TOKEN_PRIVATE_JWK:
      internalTokenSignerConfigShape.INTERNAL_TOKEN_PRIVATE_JWK.optional(),
  })
  .superRefine((config, context) => {
    if (!config.BILLING_USAGE_ENABLED) return;
    for (const key of [
      'ORGANIZATION_SERVICE_URL',
      'STORAGE_SERVICE_URL',
      'INTERNAL_TOKEN_PRIVATE_JWK',
    ] as const) {
      if (config[key] === undefined) {
        context.addIssue({
          code: 'custom',
          path: [key],
          message: 'Required when Billing usage is enabled.',
        });
      }
    }
  });

/**
 * Interface MigrationConfig
 *
 * @description
 * Variable the one-off migration container reads (`node dist/migrate.js`). The running service
 * never reads it: only the migrator role may change the structure of the database.
 */
export interface MigrationConfig {
  // #region Properties
  /**
   * Property MIGRATION_DATABASE_URL
   *
   * @description
   * Connection string of the migrator role (`billing_migrator`), which owns the tables and runs the
   * DDL. A secret; cadenway-ops passes it from `BILLING_SERVICE_MIGRATION_DATABASE_URL`.
   *
   * @type {string}
   * @readonly
   */
  readonly MIGRATION_DATABASE_URL: string;
  // #endregion
}

/**
 * Constant migrationConfigSchema
 *
 * @description
 * Zod schema of `MigrationConfig`: a `postgres://` or `postgresql://` URL, like `DATABASE_URL`.
 *
 * @type {z.ZodType<MigrationConfig>}
 */
export const migrationConfigSchema: z.ZodType<MigrationConfig> = z.object({
  MIGRATION_DATABASE_URL: z.url({
    protocol: /^postgres(?:ql)?$/u,
    error: 'Expected the postgres:// URL of the migrator role.',
  }),
});
