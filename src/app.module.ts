import {
  CONFIG,
  ConfigModule,
  createApplication,
  HealthModule,
  postgresIndicator,
  ProblemException,
  toProblem,
} from '@cadenway/nest-common';
import type { CreateApplicationOptions, PostgresProbe } from '@cadenway/nest-common';
import { DATABASE_POOL, DatabaseModule } from '@cadenway/nest-common/database';
import {
  MessagingConnection,
  MessagingModule,
  messagingHealthIndicator,
} from '@cadenway/nest-messaging';
import { OutboxModule } from '@cadenway/nest-messaging/outbox';
import { Module } from '@nestjs/common';
import type { DynamicModule, Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';

import { appConfigSchema } from './config/app-config.js';
import type { AppConfig } from './config/app-config.js';
import { configureBillingReadCache } from './infrastructure/http/billing-read-cache.js';
import { PaymentsModule } from './modules/payments/payments.module.js';
import { PlansModule } from './modules/plans/plans.module.js';
import { PlatformModule } from './modules/platform/platform.module.js';
import { UsageModule } from './modules/usage/usage.module.js';

/**
 * Class AppModule
 *
 * @description
 * Root module of the service. `createApplication` of `@cadenway/nest-common` wraps it with the
 * logs, the `application/problem+json` errors, the validation pipe, the internal token guard and
 * the other shared formats; this module declares what the service itself depends on. Importing it
 * reads no configuration: every module below is built when the application is created.
 *
 * - `ConfigModule` (`eager: false`): the environment is validated against `appConfigSchema` when
 *   the application is created and provided as `CONFIG`; an invalid one makes `createApplication`
 *   reject with the `ConfigError`, which `runApplication` writes as one line.
 * - `DatabaseModule`: the pool of this service's own database, opened as the application role of
 *   `DATABASE_URL`, the tenant and system transaction runners, and the `Idempotency-Key`
 *   interceptor for the routes marked `@Idempotent()`. The pool closes on shutdown.
 * - `MessagingModule`: the NATS connection of the `billing` user, with the inbox prefix
 *   `_INBOX.billing` the broker requires. The creation waits for the first connection, then checks
 *   that the `EVENTS` stream exists: cadenway-ops creates the streams (`manageStreams: false`), and
 *   only notification-service runs the dead-letter worker. The Usage module attaches its retained
 *   consumers when the projection worker is enabled.
 * - `OutboxModule`: the outbox writer, the PostgreSQL deduplicator and the relay, which polls
 *   `outbox_events` every second in a system transaction and publishes the pending rows. It runs in
 *   every replica; `for update skip locked` keeps two of them from publishing the same row.
 * - `HealthModule`: `GET /health/live` answers as soon as the process runs; `GET /health/ready`
 *   answers 503 while PostgreSQL or NATS does not answer within 1 second, and from the start of a
 *   shutdown. Both routes are exempt from the internal token, every other route requires it.
 *   `shutdownDelayMs` is 0: nothing that routes to this internal service reads its readiness.
 *   Callers reach it through the Docker DNS of the `internal` network, which keeps returning a
 *   stopping container until it exits, whatever its health (checked on Docker 28.2), and the GitOps
 *   agent only waits for the new container to be healthy before it stops the old one. A delay would
 *   lengthen every stop, under the 10 second default grace period of Docker, without moving any
 *   request away; set it above the probe interval of a proxy if one ever routes on readiness.
 * - `PlatformModule`: the owner of the kit tables in the migrations of the service.
 *
 * Business modules under `src/modules/` are registered here as they are created.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ schema: appConfigSchema, eager: false }),
    DatabaseModule.forRootAsync({
      inject: [CONFIG],
      useFactory: (config: AppConfig) => ({
        connectionString: config.DATABASE_URL,
        applicationName: 'billing-service',
        transactionMaxAttempts: config.DATABASE_TRANSACTION_MAX_ATTEMPTS,
        idempotency: true,
      }),
    }),
    MessagingModule.forRootAsync({
      inject: [CONFIG],
      useFactory: (config: AppConfig) => ({
        service: 'billing-service',
        servers: config.NATS_URL,
        user: config.NATS_USER,
        password: config.NATS_PASSWORD,
        manageStreams: false,
        deadLetterWorker: false,
      }),
    }),
    OutboxModule.forRoot(),
    HealthModule.forRootAsync({
      inject: [DATABASE_POOL, MessagingConnection],
      useFactory: (pool: PostgresProbe, connection: MessagingConnection) => ({
        indicators: [postgresIndicator(pool), messagingHealthIndicator(connection)],
        shutdownDelayMs: 0,
      }),
    }),
    PlatformModule,
    PaymentsModule,
    PlansModule,
    UsageModule,
  ],
})
export class AppModule {}

const stripeWebhookPath = '/internal/v1/billing/webhooks/stripe';
const stripeWebhookRoute = /^\/internal\/v1\/billing\/webhooks\/stripe\/?$/iu;

/** Creates Billing with the shared byte limit and private webhook responses. */
export async function createBillingApplication(
  config: Readonly<AppConfig>,
  applicationModule: Type | DynamicModule = AppModule,
  logDestination?: CreateApplicationOptions['logDestination'],
): Promise<NestExpressApplication> {
  const app = await createApplication(applicationModule, {
    service: 'billing-service',
    config,
    rawJsonPostPaths: [stripeWebhookPath],
    ...(logDestination === undefined ? {} : { logDestination }),
    internalToken: {
      verifier: {
        audience: config.INTERNAL_TOKEN_AUDIENCE,
        trustedIssuers: config.INTERNAL_TOKEN_TRUSTED_ISSUERS,
      },
    },
  });
  configureBillingReadCache(app);
  app.use(stripeWebhookRoute, (_request: Request, response: Response, next: NextFunction): void => {
    response.setHeader('Cache-Control', 'private, no-store');
    next();
  });
  app.use(
    stripeWebhookRoute,
    (error: unknown, _request: Request, response: Response, next: NextFunction): void => {
      response.setHeader('Cache-Control', 'private, no-store');
      const problem = toProblem(error);
      if (problem.status === 400 && problem.code !== 'request.body-too-large') {
        next(new ProblemException({ status: 400, code: 'billing.invalid-webhook' }));
        return;
      }
      next(error);
    },
  );
  return app;
}
