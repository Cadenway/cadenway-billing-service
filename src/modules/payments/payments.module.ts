import { Module } from '@nestjs/common';

import { PlansModule } from '../plans/plans.module.js';
import { GetBillingEntitlement } from './application/use-cases/queries/subscriptions/get-billing-entitlement/get-billing-entitlement.use-case.js';
import { listBillingInvoicesProvider } from './composition/providers/use-cases/invoices/list-billing-invoices.provider.js';
import { admitStripeWebhookProvider } from './composition/providers/use-cases/subscriptions/admit-stripe-webhook.provider.js';
import { getBillingEntitlementProvider } from './composition/providers/use-cases/subscriptions/get-billing-entitlement.provider.js';
import { reconcileStripeSubscriptionProvider } from './composition/providers/use-cases/subscriptions/reconcile-stripe-subscription.provider.js';
import { BillingEntitlementController } from './presentation/http/controllers/entitlement/billing-entitlement.controller.js';
import { BillingInvoicesController } from './presentation/http/controllers/invoices/billing-invoices.controller.js';
import { StripeWebhookController } from './presentation/http/webhooks/stripe/stripe-webhook.controller.js';

/** Owns the Stripe payment capability. See `MODULE.md`. */
@Module({
  imports: [PlansModule],
  controllers: [StripeWebhookController, BillingEntitlementController, BillingInvoicesController],
  providers: [
    admitStripeWebhookProvider,
    getBillingEntitlementProvider,
    listBillingInvoicesProvider,
    reconcileStripeSubscriptionProvider,
  ],
  exports: [GetBillingEntitlement],
})
export class PaymentsModule {}
