import type { FactoryProvider } from '@nestjs/common';

import { GetFreePlan } from '../../../../application/use-cases/queries/limits/get-free-plan/get-free-plan.use-case.js';

/** Provides the plan entitlement query. */
export const getFreePlanProvider: FactoryProvider<GetFreePlan> = {
  provide: GetFreePlan,
  useFactory: (): GetFreePlan => new GetFreePlan(),
};
