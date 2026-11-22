import { CONFIG } from '@cadenway/nest-common';
import { TenantTransactionRunner } from '@cadenway/nest-common/database';
import type { DatabaseSchema } from '@cadenway/nest-common/database';
import { EventConsumers } from '@cadenway/nest-messaging';
import type { FactoryProvider } from '@nestjs/common';

import type { AppConfig } from '../../../../../../config/app-config.js';
import { GetBillingEntitlement } from '../../../../../payments/public/subscriptions/get-billing-entitlement.js';
import { RecordUsageObservation } from '../../../../application/use-cases/commands/observations/record-usage-observation/record-usage-observation.use-case.js';
import { DrizzleUsageObservationUnitOfWork } from '../../../../infrastructure/persistence/drizzle/transactions/observations/drizzle-usage-observation.unit-of-work.js';
import { DrizzleUsageRebuildUnitOfWork } from '../../../../infrastructure/persistence/drizzle/transactions/rebuild/drizzle-usage-rebuild.unit-of-work.js';
import { UsageObservationEventsHandler } from '../../../../presentation/messaging/handlers/observations/usage-observation-events.handler.js';
import { UsageOrganizationCreatedHandler } from '../../../../presentation/messaging/handlers/observations/usage-organization-created.handler.js';

const observationsProvider: FactoryProvider<UsageObservationEventsHandler> = {
  provide: UsageObservationEventsHandler,
  inject: [EventConsumers, TenantTransactionRunner, GetBillingEntitlement, CONFIG],
  useFactory: (
    consumers: EventConsumers,
    runner: TenantTransactionRunner<DatabaseSchema>,
    entitlement: GetBillingEntitlement,
    config: AppConfig,
  ): UsageObservationEventsHandler => {
    const observations = new DrizzleUsageObservationUnitOfWork(runner, (organizationId) =>
      entitlement.execute({ organizationId }),
    );
    return new UsageObservationEventsHandler(
      consumers,
      new RecordUsageObservation(observations),
      config.BILLING_USAGE_ENABLED,
    );
  },
};

const organizationCreatedProvider: FactoryProvider<UsageOrganizationCreatedHandler> = {
  provide: UsageOrganizationCreatedHandler,
  inject: [EventConsumers, TenantTransactionRunner, CONFIG],
  useFactory: (
    consumers: EventConsumers,
    runner: TenantTransactionRunner<DatabaseSchema>,
    config: AppConfig,
  ): UsageOrganizationCreatedHandler => {
    const rebuild = new DrizzleUsageRebuildUnitOfWork(runner);
    return new UsageOrganizationCreatedHandler(
      consumers,
      {
        execute: ({ organizationId }) =>
          rebuild.run(organizationId, (transaction) => transaction.lockOrganization()),
      },
      config.BILLING_USAGE_ENABLED,
    );
  },
};

/** Registers the retained source consumers and the transaction-bound threshold writer. */
export const usageObservationProviders = [observationsProvider, organizationCreatedProvider];
