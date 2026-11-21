import { Module } from '@nestjs/common';

import { GetFreePlan } from './application/use-cases/queries/limits/get-free-plan/get-free-plan.use-case.js';
import { getFreePlanProvider } from './composition/providers/use-cases/limits/get-free-plan.provider.js';

/** Owns the included limits of Billing plans. See `MODULE.md`. */
@Module({ providers: [getFreePlanProvider], exports: [GetFreePlan] })
export class PlansModule {}
