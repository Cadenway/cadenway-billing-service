import { CONFIG } from '@cadenway/nest-common';
import { TenantTransactionRunner, type DatabaseSchema } from '@cadenway/nest-common/database';
import { OutboxWriter } from '@cadenway/nest-messaging/outbox/writer';
import type { FactoryProvider } from '@nestjs/common';

import type { AppConfig } from '../../../../../../config/app-config.js';
import { GetFreePlan } from '../../../../../plans/public/limits/get-free-plan.js';
import { ReconcileStripeSubscription } from '../../../../application/use-cases/commands/subscriptions/reconcile-stripe-subscription/reconcile-stripe-subscription.use-case.js';
import { createStripeSubscriptionProvider } from '../../../../infrastructure/adapters/stripe/stripe-subscription-provider.adapter.js';
import { StripeEntitlementOutbox } from '../../../../infrastructure/messaging/outbox/subscriptions/stripe-entitlement-outbox.adapter.js';
import { DrizzleStripeBindingReader } from '../../../../infrastructure/persistence/drizzle/repositories/subscriptions/drizzle-stripe-binding.repository.js';
import { DrizzleStripeReconciliationUnitOfWork } from '../../../../infrastructure/persistence/drizzle/transactions/subscriptions/drizzle-stripe-reconciliation.unit-of-work.js';
import { StripeEntitlementOutboxFence } from '../../../../infrastructure/persistence/drizzle/transactions/subscriptions/stripe-entitlement-outbox-fence.transaction.js';

/** Binds Stripe settlement and the explicit gate for publishing a return to Free. */
export const reconcileStripeSubscriptionProvider: FactoryProvider<ReconcileStripeSubscription | null> =
  {
    provide: ReconcileStripeSubscription,
    inject: [CONFIG, TenantTransactionRunner, GetFreePlan, OutboxWriter],
    useFactory: (
      config: AppConfig,
      tenant: TenantTransactionRunner<DatabaseSchema>,
      plans: GetFreePlan,
      writer: OutboxWriter,
    ): ReconcileStripeSubscription | null => {
      if (!config.BILLING_STRIPE_SETTLEMENT_ENABLED) return null;
      const { BILLING_STRIPE_API_KEY: key, BILLING_STRIPE_TEAM_PRICE_IDS: prices } = config;
      if (key === undefined || prices === undefined) {
        throw new Error('Stripe settlement configuration is incomplete.');
      }

      const liveMode = config.BILLING_STRIPE_WEBHOOK_MODE === 'live';
      const { seats, storageBytes } = plans.execute();
      const freeReturnEnabled = config.BILLING_STRIPE_FREE_RETURN_ENABLED;
      const fence = new StripeEntitlementOutboxFence(
        { seatLimit: seats, storageByteLimit: storageBytes },
        new StripeEntitlementOutbox(writer),
        freeReturnEnabled,
      );
      return new ReconcileStripeSubscription(
        new DrizzleStripeBindingReader(tenant),
        createStripeSubscriptionProvider(key, liveMode),
        new DrizzleStripeReconciliationUnitOfWork(tenant, fence),
        {
          liveMode,
          teamPriceIds: prices,
          freePlanLimits: { seats, storageBytes },
          freeReturnEnabled,
        },
      );
    },
  };
