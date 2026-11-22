import { CONFIG } from '@cadenway/nest-common';
import {
  SystemTransactionRunner,
  TenantTransactionRunner,
  type DatabaseSchema,
} from '@cadenway/nest-common/database';
import type { FactoryProvider } from '@nestjs/common';

import type { AppConfig } from '../../../../../../config/app-config.js';
import { ReconcileStripeCheckout } from '../../../../application/use-cases/commands/checkout/reconcile-stripe-checkout/reconcile-stripe-checkout.use-case.js';
import { AdmitStripeWebhook } from '../../../../application/use-cases/commands/subscriptions/admit-stripe-webhook/admit-stripe-webhook.use-case.js';
import { ReconcileStripeSubscription } from '../../../../application/use-cases/commands/subscriptions/reconcile-stripe-subscription/reconcile-stripe-subscription.use-case.js';
import { runStripeBillingScope } from '../../../../infrastructure/adapters/stripe/run-stripe-billing-scope.adapter.js';
import { createStripeWebhookAuthenticator } from '../../../../infrastructure/adapters/stripe/stripe-webhook-authenticator.adapter.js';
import { DrizzleStripeCheckoutAttemptReader } from '../../../../infrastructure/persistence/drizzle/repositories/checkout/drizzle-stripe-checkout-attempt-reader.repository.js';
import { DrizzleStripeWebhookBindingReader } from '../../../../infrastructure/persistence/drizzle/repositories/subscriptions/drizzle-stripe-webhook-binding.repository.js';
import { DrizzleStripeWebhookInboxWrites } from '../../../../infrastructure/persistence/drizzle/repositories/webhooks/drizzle-stripe-webhook-inbox-writes.repository.js';

/** Starts with settlement gated on a real quota fence and subscription outbox. */
export const admitStripeWebhookProvider: FactoryProvider<AdmitStripeWebhook> = {
  provide: AdmitStripeWebhook,
  inject: [
    CONFIG,
    SystemTransactionRunner,
    TenantTransactionRunner,
    ReconcileStripeSubscription,
    ReconcileStripeCheckout,
  ],
  useFactory: (
    config: AppConfig,
    runner: SystemTransactionRunner<DatabaseSchema>,
    tenant: TenantTransactionRunner<DatabaseSchema>,
    reconciliation: ReconcileStripeSubscription | null,
    checkout: ReconcileStripeCheckout | null,
  ) => {
    const secrets = config.BILLING_STRIPE_WEBHOOK_SECRETS;
    const inbox = new DrizzleStripeWebhookInboxWrites(tenant);
    return new AdmitStripeWebhook(
      secrets === undefined
        ? () => ({ kind: 'unavailable' })
        : createStripeWebhookAuthenticator(config.BILLING_STRIPE_WEBHOOK_MODE === 'live', secrets),
      new DrizzleStripeWebhookBindingReader(runner),
      reconciliation === null
        ? null
        : (delivery) =>
            runStripeBillingScope(delivery.organizationId, () => reconciliation.execute(delivery)),
      checkout === null ? null : (delivery) => checkout.execute(delivery),
      config.BILLING_STRIPE_WEBHOOK_INBOX_ENABLED
        ? {
            checkoutAttempts: new DrizzleStripeCheckoutAttemptReader(runner),
            enqueue: (delivery) =>
              runStripeBillingScope(delivery.organizationId, () => inbox.enqueue(delivery)),
          }
        : null,
    );
  },
};
