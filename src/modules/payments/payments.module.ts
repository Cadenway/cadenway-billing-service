import { Module } from '@nestjs/common';

import { admitStripeWebhookProvider } from './composition/providers/use-cases/subscriptions/admit-stripe-webhook.provider.js';
import { StripeWebhookController } from './presentation/http/webhooks/stripe/stripe-webhook.controller.js';

/** Owns the Stripe payment capability. See `MODULE.md`. */
@Module({ controllers: [StripeWebhookController], providers: [admitStripeWebhookProvider] })
export class PaymentsModule {}
