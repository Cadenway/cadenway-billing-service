import { CONFIG, runWithOrganizationContext } from '@cadenway/nest-common';
import { SystemTransactionRunner, type DatabaseSchema } from '@cadenway/nest-common/database';
import type { FactoryProvider } from '@nestjs/common';

import type { AppConfig } from '../../../../../../config/app-config.js';
import { AdmitStripeWebhook } from '../../../../application/use-cases/commands/subscriptions/admit-stripe-webhook/admit-stripe-webhook.use-case.js';
import { ReconcileStripeSubscription } from '../../../../application/use-cases/commands/subscriptions/reconcile-stripe-subscription/reconcile-stripe-subscription.use-case.js';
import { createStripeWebhookAuthenticator } from '../../../../infrastructure/adapters/stripe/stripe-webhook-authenticator.adapter.js';
import { DrizzleStripeWebhookBindingReader } from '../../../../infrastructure/persistence/drizzle/repositories/subscriptions/drizzle-stripe-webhook-binding.repository.js';

/** Starts with settlement gated on a real quota fence and subscription outbox. */
export const admitStripeWebhookProvider: FactoryProvider<AdmitStripeWebhook> = {
  provide: AdmitStripeWebhook,
  inject: [CONFIG, SystemTransactionRunner, { token: ReconcileStripeSubscription, optional: true }],
  useFactory: (
    config: AppConfig,
    runner: SystemTransactionRunner<DatabaseSchema>,
    reconciliation?: ReconcileStripeSubscription,
  ) => {
    const secrets = config.BILLING_STRIPE_WEBHOOK_SECRETS;
    return new AdmitStripeWebhook(
      secrets === undefined
        ? () => ({ kind: 'unavailable' })
        : createStripeWebhookAuthenticator(config.BILLING_STRIPE_WEBHOOK_MODE === 'live', secrets),
      new DrizzleStripeWebhookBindingReader(runner),
      reconciliation === undefined
        ? null
        : (delivery) =>
            runWithOrganizationContext(
              {
                organizationId: delivery.organizationId,
                actor: { type: 'system', id: 'billing-service' },
                role: null,
                scopes: [],
              },
              () => reconciliation.execute(delivery),
            ),
    );
  },
};
