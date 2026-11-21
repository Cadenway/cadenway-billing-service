import { Module } from '@nestjs/common';

import { PlansModule } from '../plans/plans.module.js';
import { getBillingSubscriptionProvider } from './composition/providers/use-cases/subscription/get-billing-subscription.provider.js';
import { BillingSubscriptionController } from './presentation/http/controllers/subscription/billing-subscription.controller.js';

/** Owns the measurement and assessment of Billing quota usage. See `MODULE.md`. */
@Module({
  imports: [PlansModule],
  controllers: [BillingSubscriptionController],
  providers: [getBillingSubscriptionProvider],
})
export class UsageModule {}
