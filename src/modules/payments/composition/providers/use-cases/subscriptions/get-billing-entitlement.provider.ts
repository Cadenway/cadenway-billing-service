import { TenantTransactionRunner, type DatabaseSchema } from '@cadenway/nest-common/database';
import type { FactoryProvider } from '@nestjs/common';

import { GetFreePlan } from '../../../../../plans/public/limits/get-free-plan.js';
import { GetBillingEntitlement } from '../../../../application/use-cases/queries/subscriptions/get-billing-entitlement/get-billing-entitlement.use-case.js';
import { DrizzleBillingEntitlementReader } from '../../../../infrastructure/persistence/drizzle/repositories/subscriptions/drizzle-billing-entitlement.repository.js';

/** Binds the committed entitlement reader and the shared Free baseline. */
export const getBillingEntitlementProvider: FactoryProvider<GetBillingEntitlement> = {
  provide: GetBillingEntitlement,
  inject: [TenantTransactionRunner, GetFreePlan],
  useFactory: (
    tenant: TenantTransactionRunner<DatabaseSchema>,
    plans: GetFreePlan,
  ): GetBillingEntitlement => {
    const reader = new DrizzleBillingEntitlementReader(tenant);
    const free = plans.execute();
    return new GetBillingEntitlement((organizationId) => reader.read(organizationId), {
      plan: free.id,
      seatLimit: free.seats,
      storageByteLimit: free.storageBytes,
      version: 0,
    });
  },
};
