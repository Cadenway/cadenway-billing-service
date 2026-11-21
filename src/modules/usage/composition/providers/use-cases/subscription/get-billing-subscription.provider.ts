import { TenantTransactionRunner } from '@cadenway/nest-common/database';
import type { DatabaseSchema } from '@cadenway/nest-common/database';
import type { FactoryProvider } from '@nestjs/common';

import { GetFreePlan } from '../../../../../plans/public/limits/get-free-plan.js';
import { GetBillingSubscription } from '../../../../application/use-cases/queries/subscription/get-billing-subscription/get-billing-subscription.use-case.js';
import { DrizzleActiveUsageReader } from '../../../../infrastructure/persistence/drizzle/repositories/usage/drizzle-active-usage.repository.js';

/** Binds the P5 subscription query to the Free plan and the tenant usage reader. */
export const getBillingSubscriptionProvider: FactoryProvider<GetBillingSubscription> = {
  provide: GetBillingSubscription,
  inject: [TenantTransactionRunner, GetFreePlan],
  useFactory: (
    runner: TenantTransactionRunner<DatabaseSchema>,
    plans: GetFreePlan,
  ): GetBillingSubscription =>
    new GetBillingSubscription(new DrizzleActiveUsageReader(runner), plans.execute()),
};
