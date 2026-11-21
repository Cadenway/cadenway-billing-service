import { CONFIG, InternalHttpClient, InternalTokenSigner, PinoLogger } from '@cadenway/nest-common';
import { SystemTransactionRunner, TenantTransactionRunner } from '@cadenway/nest-common/database';
import type { DatabaseSchema } from '@cadenway/nest-common/database';
import { EventConsumers, MessagingConnection } from '@cadenway/nest-messaging';
import { OutboxWriter } from '@cadenway/nest-messaging/outbox/writer';
import type { FactoryProvider } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

import type { AppConfig } from '../../../../../../config/app-config.js';
import { AdvanceUsageRebuild } from '../../../../application/services/rebuild/advance-usage-rebuild.service.js';
import { ApplyUsageRebuildPage } from '../../../../application/use-cases/commands/rebuild/apply-usage-rebuild-page/apply-usage-rebuild-page.use-case.js';
import { InvalidateActiveUsage } from '../../../../application/use-cases/commands/rebuild/invalidate-active-usage/invalidate-active-usage.use-case.js';
import { PromoteUsageRebuild } from '../../../../application/use-cases/commands/rebuild/promote-usage-rebuild/promote-usage-rebuild.use-case.js';
import { StartUsageRebuild } from '../../../../application/use-cases/commands/rebuild/start-usage-rebuild/start-usage-rebuild.use-case.js';
import { BillingUsageBrokerProof } from '../../../../infrastructure/adapters/jetstream/billing-usage-broker-proof.adapter.js';
import { JetStreamUsageBrokerProgressAdapter } from '../../../../infrastructure/adapters/jetstream/jetstream-usage-broker-progress.adapter.js';
import { UsageRebuildScheduler } from '../../../../infrastructure/adapters/rebuild/usage-rebuild-scheduler.adapter.js';
import { UsageSnapshotHttpAdapter } from '../../../../infrastructure/adapters/usage-snapshot/usage-snapshot-http.adapter.js';
import { QuotaThresholdOutbox } from '../../../../infrastructure/messaging/outbox/quotas/quota-threshold-outbox.adapter.js';
import { DrizzleUsageRebuildRegistryReader } from '../../../../infrastructure/persistence/drizzle/repositories/rebuild/drizzle-usage-rebuild-registry.repository.js';
import { DrizzleUsageRebuildStateReader } from '../../../../infrastructure/persistence/drizzle/repositories/rebuild/drizzle-usage-rebuild-state.repository.js';
import { DrizzleUsageRebuildUnitOfWork } from '../../../../infrastructure/persistence/drizzle/transactions/rebuild/drizzle-usage-rebuild.unit-of-work.js';
import { usageObservationHandlerNames } from '../../../../presentation/messaging/handlers/observations/usage-observation-events.handler.js';

/** Starts the bounded projection scheduler once the HTTP server has finished bootstrapping. */
export const usageRebuildProvider: FactoryProvider<UsageRebuildScheduler | null> = {
  provide: UsageRebuildScheduler,
  inject: [
    CONFIG,
    TenantTransactionRunner,
    SystemTransactionRunner,
    MessagingConnection,
    EventConsumers,
    OutboxWriter,
    HttpAdapterHost,
    PinoLogger,
  ],
  useFactory: async (
    config: AppConfig,
    tenant: TenantTransactionRunner<DatabaseSchema>,
    system: SystemTransactionRunner<DatabaseSchema>,
    connection: MessagingConnection,
    consumers: EventConsumers,
    outbox: OutboxWriter,
    host: HttpAdapterHost,
    logger: PinoLogger,
  ): Promise<UsageRebuildScheduler | null> => {
    if (!config.BILLING_USAGE_ENABLED) return null;
    const {
      ORGANIZATION_SERVICE_URL: organization,
      STORAGE_SERVICE_URL: storage,
      INTERNAL_TOKEN_PRIVATE_JWK: privateJwk,
    } = config;
    if (!organization || !storage || !privateJwk) {
      throw new Error('Billing usage requires both source origins and its signing key.');
    }

    const signer = await InternalTokenSigner.create({ issuer: 'billing-service', privateJwk });
    const source = new UsageSnapshotHttpAdapter(
      new InternalHttpClient({ service: 'organization-service', baseUrl: organization, signer }),
      new InternalHttpClient({ service: 'storage-service', baseUrl: storage, signer }),
    );
    const proof = new BillingUsageBrokerProof(usageObservationHandlerNames);
    const writer = new QuotaThresholdOutbox(outbox);
    const rebuild = new DrizzleUsageRebuildUnitOfWork(
      tenant,
      (scope, organizationId, version, fact) => writer.append(scope, organizationId, version, fact),
    );
    const advance = new AdvanceUsageRebuild(
      new DrizzleUsageRebuildStateReader(tenant),
      new JetStreamUsageBrokerProgressAdapter(connection, consumers, usageObservationHandlerNames),
      proof,
      source,
      new StartUsageRebuild(rebuild, proof),
      new ApplyUsageRebuildPage(rebuild),
      new PromoteUsageRebuild(rebuild, proof),
      new InvalidateActiveUsage(rebuild),
      rebuild,
    );
    return new UsageRebuildScheduler(
      source,
      new DrizzleUsageRebuildRegistryReader(system),
      async (organizationId) => {
        await rebuild.run(organizationId, (transaction) => transaction.lockOrganization());
      },
      advance,
      host,
      true,
      logger,
    );
  },
};
