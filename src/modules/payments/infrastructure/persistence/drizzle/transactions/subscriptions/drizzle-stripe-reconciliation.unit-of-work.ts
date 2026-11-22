import type { DatabaseSchema, TenantTransactionRunner } from '@cadenway/nest-common/database';
import { and, eq, sql } from 'drizzle-orm';

import type { StripeSubscriptionDecision } from '../../../../../domain/value-objects/subscriptions/stripe-subscription-decision.value-object.js';
import type { StripeReconciliationUnitOfWork } from '../../../../../application/ports/outbound/transactions/subscriptions/stripe-reconciliation-unit-of-work.port.js';
import type { StripeReconciliationTransaction } from '../../../../../application/ports/outbound/transactions/subscriptions/stripe-reconciliation-transaction.port.js';
import {
  stripeBindings,
  stripeReconciliationReceipts,
  stripeSubscriptionSnapshots,
} from '../../schemas/subscriptions/stripe-subscriptions.schema.js';
import { lockBillingEntitlement } from './lock-billing-entitlement.transaction.js';
import type { StripeEntitlementFence } from './stripe-entitlement-fence.transaction.js';

type Entitlement = Extract<StripeSubscriptionDecision, { readonly kind: 'apply' }>;

/** Serializes provider receipts and entitlement changes within a tenant transaction. */
export class DrizzleStripeReconciliationUnitOfWork implements StripeReconciliationUnitOfWork {
  // #region Constructor
  /** Authorizes and records changes in the same transaction as the committed snapshot. */
  public constructor(
    private readonly runner: TenantTransactionRunner<DatabaseSchema>,
    private readonly fence: StripeEntitlementFence,
  ) {}
  // #endregion

  // #region Methods
  /** Locks the binding before reading receipts or changing the entitlement. */
  public run<T>(
    organizationId: string,
    work: (transaction: StripeReconciliationTransaction) => Promise<T>,
  ): Promise<T> {
    return this.runner.run(async (scope) => {
      if (scope.kind !== 'tenant' || scope.organizationId !== organizationId) {
        throw new Error('Stripe reconciliation organization does not match the tenant scope.');
      }
      let locked = false;
      const requireLock = (): void => {
        if (!locked) throw new Error('The Stripe binding must be locked first.');
      };
      return await work({
        lockBinding: async () => {
          await lockBillingEntitlement(scope, organizationId, 'exclusive');
          await scope.client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
            `billing.checkout:${organizationId.toLowerCase()}`,
          ]);
          // A possibly payable Checkout must settle before unrelated subscription events can
          // replace the entitlement. Its terminal transaction uses these same locks in order.
          const pending = await scope.client.query(
            `select id from stripe_checkout_attempts
             where organization_id = $1 and provider_started_at is not null and resolved_at is null
             limit 1 for update`,
            [organizationId],
          );
          if (pending.rows.length !== 0) return null;
          const [row] = await scope.db
            .select()
            .from(stripeBindings)
            .where(eq(stripeBindings.organizationId, organizationId))
            .limit(1)
            .for('update');
          locked = row !== undefined;
          return row === undefined
            ? null
            : {
                revision: row.version,
                binding: { customerId: row.customerId, subscriptionId: row.subscriptionId },
              };
        },
        isSettled: async (eventId) => {
          const [row] = await scope.db
            .select({ eventId: stripeReconciliationReceipts.eventId })
            .from(stripeReconciliationReceipts)
            .where(
              and(
                eq(stripeReconciliationReceipts.organizationId, organizationId),
                eq(stripeReconciliationReceipts.eventId, eventId),
              ),
            )
            .limit(1);
          return row !== undefined;
        },
        apply: async (decision) => {
          requireLock();
          const [row] = await scope.db
            .select()
            .from(stripeSubscriptionSnapshots)
            .where(eq(stripeSubscriptionSnapshots.organizationId, organizationId))
            .limit(1)
            .for('update');
          // A settled cancellation is terminal for this binding. Only a paid Checkout can
          // replace it and restore Team.
          if (row?.plan === 'free' && decision.plan === 'team') return 'unchanged';
          const previous: Entitlement | null =
            row === undefined
              ? null
              : row.plan === 'free'
                ? {
                    kind: 'apply',
                    plan: 'free',
                    limits: { seats: row.seats, storageBytes: row.storageBytes },
                  }
                : {
                    kind: 'apply',
                    plan: 'team',
                    limits: { seats: row.seats, storageBytes: row.storageBytes },
                    scheduledCancellation: row.scheduledCancellation,
                  };
          const scheduledCancellation = decision.plan === 'team' && decision.scheduledCancellation;
          if (
            row?.plan === decision.plan &&
            row.seats === decision.limits.seats &&
            row.storageBytes === decision.limits.storageBytes
          ) {
            if (row.scheduledCancellation !== scheduledCancellation) {
              await scope.db
                .update(stripeSubscriptionSnapshots)
                .set({ scheduledCancellation, updatedAt: sql`now()` })
                .where(eq(stripeSubscriptionSnapshots.organizationId, organizationId));
            }
            return 'unchanged';
          }
          const nextVersion = (row?.version ?? 0) + 1;
          if (!Number.isSafeInteger(nextVersion))
            throw new Error('Stripe entitlement version exhausted.');
          if (
            !(await this.fence.authorizeChange(
              scope,
              organizationId,
              previous,
              decision,
              nextVersion,
            ))
          )
            return 'deferred';
          await scope.db
            .insert(stripeSubscriptionSnapshots)
            .values({
              organizationId,
              plan: decision.plan,
              seats: decision.limits.seats,
              storageBytes: decision.limits.storageBytes,
              scheduledCancellation,
              version: nextVersion,
            })
            .onConflictDoUpdate({
              target: stripeSubscriptionSnapshots.organizationId,
              set: {
                plan: decision.plan,
                seats: decision.limits.seats,
                storageBytes: decision.limits.storageBytes,
                scheduledCancellation,
                version: nextVersion,
                updatedAt: sql`now()`,
              },
            });
          return 'applied';
        },
        settle: async (eventId) => {
          requireLock();
          await scope.db.insert(stripeReconciliationReceipts).values({ organizationId, eventId });
          await scope.db
            .update(stripeBindings)
            .set({ version: sql`${stripeBindings.version} + 1`, updatedAt: sql`now()` })
            .where(eq(stripeBindings.organizationId, organizationId));
        },
      });
    });
  }
  // #endregion
}
