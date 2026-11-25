import { CONFIG } from '@cadenway/nest-common';
import { TenantTransactionRunner } from '@cadenway/nest-common/database';
import type { DatabaseSchema } from '@cadenway/nest-common/database';
import { EventConsumers, MessagingConnection } from '@cadenway/nest-messaging';
import type { FactoryProvider } from '@nestjs/common';

import type { AppConfig } from '../../../../../../config/app-config.js';
import { GetBillingEntitlement } from '../../../../../payments/public/subscriptions/get-billing-entitlement.js';
import { sameAdvisoryObservation } from '../../../../application/models/rebuild/usage-advisory-observation.model.js';
import { GetBillingSubscription } from '../../../../application/use-cases/queries/subscription/get-billing-subscription/get-billing-subscription.use-case.js';
import { BillingUsageBrokerProof } from '../../../../infrastructure/adapters/jetstream/billing-usage-broker-proof.adapter.js';
import { JetStreamUsageBrokerProgressAdapter } from '../../../../infrastructure/adapters/jetstream/jetstream-usage-broker-progress.adapter.js';
import { DrizzleActiveUsageReader } from '../../../../infrastructure/persistence/drizzle/repositories/usage/drizzle-active-usage.repository.js';
import { usageObservationHandlerNames } from '../../../../presentation/messaging/handlers/observations/usage-observation-events.handler.js';

const advisoryReadTimeoutMs = 1_000;

/** Binds the committed entitlement and verifies live delivery before serving usage. */
export const getBillingSubscriptionProvider: FactoryProvider<GetBillingSubscription> = {
  provide: GetBillingSubscription,
  inject: [
    TenantTransactionRunner,
    GetBillingEntitlement,
    MessagingConnection,
    EventConsumers,
    CONFIG,
  ],
  useFactory: (
    runner: TenantTransactionRunner<DatabaseSchema>,
    entitlement: GetBillingEntitlement,
    broker: MessagingConnection,
    consumers: EventConsumers,
    config: AppConfig,
  ): GetBillingSubscription => {
    const reader = new DrizzleActiveUsageReader(runner);
    const samples = new JetStreamUsageBrokerProgressAdapter(
      broker,
      consumers,
      usageObservationHandlerNames,
    );
    const proof = new BillingUsageBrokerProof(usageObservationHandlerNames);
    return new GetBillingSubscription(
      {
        read: async (organizationId) => {
          const sample = await samples.read(AbortSignal.timeout(advisoryReadTimeoutMs));
          if (!sample?.advisoriesClear) return null;
          return reader.read(
            organizationId,
            (frontier, advisory) =>
              sameAdvisoryObservation(advisory, sample.advisory) &&
              proof.assess(frontier, sample.progress, sample.advisoriesClear) === 'covered',
          );
        },
      },
      config.BILLING_USAGE_ENABLED
        ? (organizationId) => entitlement.execute({ organizationId })
        : null,
    );
  },
};
