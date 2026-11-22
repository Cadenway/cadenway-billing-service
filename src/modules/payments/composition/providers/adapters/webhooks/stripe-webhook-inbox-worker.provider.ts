import { PinoLogger } from '@cadenway/nest-common';
import {
  SystemTransactionRunner,
  TenantTransactionRunner,
  type DatabaseSchema,
} from '@cadenway/nest-common/database';
import type { FactoryProvider } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

import { ReconcileStripeCheckout } from '../../../../application/use-cases/commands/checkout/reconcile-stripe-checkout/reconcile-stripe-checkout.use-case.js';
import { ReconcileStripeSubscription } from '../../../../application/use-cases/commands/subscriptions/reconcile-stripe-subscription/reconcile-stripe-subscription.use-case.js';
import { ReconcileStripeWebhookDelivery } from '../../../../application/use-cases/commands/subscriptions/reconcile-stripe-webhook-delivery/reconcile-stripe-webhook-delivery.use-case.js';
import { runStripeBillingScope } from '../../../../infrastructure/adapters/stripe/run-stripe-billing-scope.adapter.js';
import { StripeWebhookInboxWorker } from '../../../../infrastructure/adapters/stripe/stripe-webhook-inbox-worker.adapter.js';
import { DrizzleStripeBindingReader } from '../../../../infrastructure/persistence/drizzle/repositories/subscriptions/drizzle-stripe-binding.repository.js';
import { DrizzleStripeWebhookBindingReader } from '../../../../infrastructure/persistence/drizzle/repositories/subscriptions/drizzle-stripe-webhook-binding.repository.js';
import { DrizzleStripeWebhookInboxClaim } from '../../../../infrastructure/persistence/drizzle/repositories/webhooks/drizzle-stripe-webhook-inbox-claim.repository.js';
import { DrizzleStripeWebhookInboxWrites } from '../../../../infrastructure/persistence/drizzle/repositories/webhooks/drizzle-stripe-webhook-inbox-writes.repository.js';

/** Runs the worker whenever settlement is available, even with synchronous admission. */
export const stripeWebhookInboxWorkerProvider: FactoryProvider<StripeWebhookInboxWorker | null> = {
  provide: StripeWebhookInboxWorker,
  inject: [
    SystemTransactionRunner,
    TenantTransactionRunner,
    ReconcileStripeSubscription,
    ReconcileStripeCheckout,
    HttpAdapterHost,
    PinoLogger,
  ],
  useFactory: (
    system: SystemTransactionRunner<DatabaseSchema>,
    tenant: TenantTransactionRunner<DatabaseSchema>,
    subscription: ReconcileStripeSubscription | null,
    checkout: ReconcileStripeCheckout | null,
    host: HttpAdapterHost,
    logger: PinoLogger,
  ): StripeWebhookInboxWorker | null => {
    if (subscription === null || checkout === null) return null;
    const reader = new DrizzleStripeWebhookInboxClaim(system);
    const writes = new DrizzleStripeWebhookInboxWrites(tenant);
    const tenantBindings = new DrizzleStripeBindingReader(tenant);
    const reconcile = new ReconcileStripeWebhookDelivery(
      new DrizzleStripeWebhookBindingReader(system),
      (organizationId) =>
        runStripeBillingScope(organizationId, () => tenantBindings.read(organizationId)),
      (delivery) =>
        runStripeBillingScope(delivery.organizationId, () => subscription.execute(delivery)),
      (delivery) => checkout.execute(delivery),
    );
    return new StripeWebhookInboxWorker(
      {
        claim: () => runStripeBillingScope(null, () => reader.claim()),
        finish: (lease, outcome) =>
          runStripeBillingScope(lease.delivery.organizationId, () => writes.finish(lease, outcome)),
      },
      (delivery) => runStripeBillingScope(null, () => reconcile.execute(delivery)),
      host,
      logger,
    );
  },
};
