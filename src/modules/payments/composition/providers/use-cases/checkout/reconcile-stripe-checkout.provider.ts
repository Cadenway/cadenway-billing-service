import { CONFIG, runWithOrganizationContext } from '@cadenway/nest-common';
import {
  SystemTransactionRunner,
  TenantTransactionRunner,
  type DatabaseSchema,
} from '@cadenway/nest-common/database';
import { OutboxWriter } from '@cadenway/nest-messaging/outbox/writer';
import type { FactoryProvider } from '@nestjs/common';

import type { AppConfig } from '../../../../../../config/app-config.js';
import { GetFreePlan } from '../../../../../plans/public/limits/get-free-plan.js';
import { ReconcileStripeCheckout } from '../../../../application/use-cases/commands/checkout/reconcile-stripe-checkout/reconcile-stripe-checkout.use-case.js';
import { createStripeCheckoutSessionReader } from '../../../../infrastructure/adapters/stripe/stripe-checkout-provider.adapter.js';
import { createStripeSubscriptionProvider } from '../../../../infrastructure/adapters/stripe/stripe-subscription-provider.adapter.js';
import { StripeEntitlementOutbox } from '../../../../infrastructure/messaging/outbox/subscriptions/stripe-entitlement-outbox.adapter.js';
import { DrizzleStripeCheckoutAttemptReader } from '../../../../infrastructure/persistence/drizzle/repositories/checkout/drizzle-stripe-checkout-attempt-reader.repository.js';
import { DrizzleStripeCheckoutSettlement } from '../../../../infrastructure/persistence/drizzle/transactions/checkout/drizzle-stripe-checkout-settlement.transaction.js';
import { StripeEntitlementOutboxFence } from '../../../../infrastructure/persistence/drizzle/transactions/subscriptions/stripe-entitlement-outbox-fence.transaction.js';

/** Reconciles Stripe Checkout using canonical reads and tenant-owned settlement. */
export const reconcileStripeCheckoutProvider: FactoryProvider<ReconcileStripeCheckout | null> = {
  provide: ReconcileStripeCheckout,
  inject: [CONFIG, SystemTransactionRunner, TenantTransactionRunner, GetFreePlan, OutboxWriter],
  useFactory: (
    config: AppConfig,
    system: SystemTransactionRunner<DatabaseSchema>,
    tenant: TenantTransactionRunner<DatabaseSchema>,
    plans: GetFreePlan,
    writer: OutboxWriter,
  ): ReconcileStripeCheckout | null => {
    if (!config.BILLING_STRIPE_SETTLEMENT_ENABLED) return null;
    const { BILLING_STRIPE_API_KEY: key, BILLING_STRIPE_TEAM_PRICE_IDS: prices } = config;
    if (key === undefined || prices === undefined) {
      throw new Error('Stripe settlement configuration is incomplete.');
    }
    const liveMode = config.BILLING_STRIPE_WEBHOOK_MODE === 'live';
    const { seats, storageBytes } = plans.execute();
    const fence = new StripeEntitlementOutboxFence(
      { seatLimit: seats, storageByteLimit: storageBytes },
      new StripeEntitlementOutbox(writer),
    );
    const settlement = new DrizzleStripeCheckoutSettlement(
      tenant,
      fence,
      liveMode,
      seats,
      storageBytes,
    );
    return new ReconcileStripeCheckout(
      new DrizzleStripeCheckoutAttemptReader(system),
      createStripeCheckoutSessionReader(key, liveMode),
      createStripeSubscriptionProvider(key, liveMode),
      {
        settle: (input) =>
          runWithOrganizationContext(
            {
              organizationId: input.organizationId,
              actor: { type: 'system', id: 'billing-service' },
              role: null,
              scopes: [],
            },
            () => settlement.settle(input),
          ),
      },
      { liveMode, teamPriceIds: prices, freePlanLimits: { seats, storageBytes } },
    );
  },
};
