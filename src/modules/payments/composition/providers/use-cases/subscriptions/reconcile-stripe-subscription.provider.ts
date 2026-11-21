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
import { MonotonicStripeEntitlementFence } from '../../../../infrastructure/persistence/drizzle/transactions/subscriptions/monotonic-stripe-entitlement-fence.transaction.js';

/** Binds the real monotonic settlement only when payment admission is explicitly enabled. */
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
      const fence = new MonotonicStripeEntitlementFence(
        { seatLimit: seats, storageByteLimit: storageBytes },
        new StripeEntitlementOutbox(writer),
      );
      return new ReconcileStripeSubscription(
        new DrizzleStripeBindingReader(tenant),
        createStripeSubscriptionProvider(key, liveMode),
        new DrizzleStripeReconciliationUnitOfWork(tenant, fence),
        { liveMode, teamPriceIds: prices, freePlanLimits: { seats, storageBytes } },
      );
    },
  };
