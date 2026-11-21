import { Module } from '@nestjs/common';

import { PaymentsModule } from '../payments/payments.module.js';
import { usageObservationProviders } from './composition/providers/adapters/messaging/usage-observation.provider.js';
import { usageRebuildProvider } from './composition/providers/adapters/rebuild/usage-rebuild.provider.js';
import { getBillingSubscriptionProvider } from './composition/providers/use-cases/subscription/get-billing-subscription.provider.js';
import { BillingSubscriptionController } from './presentation/http/controllers/subscription/billing-subscription.controller.js';

/** Owns the measurement and assessment of Billing quota usage. See `MODULE.md`. */
@Module({
  imports: [PaymentsModule],
  controllers: [BillingSubscriptionController],
  providers: [getBillingSubscriptionProvider, ...usageObservationProviders, usageRebuildProvider],
})
export class UsageModule {}
