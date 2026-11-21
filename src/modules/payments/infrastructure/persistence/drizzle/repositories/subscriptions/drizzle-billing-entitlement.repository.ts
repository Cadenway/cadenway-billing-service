import type { DatabaseSchema, TenantTransactionRunner } from '@cadenway/nest-common/database';
import { eq } from 'drizzle-orm';

import type { BillingEntitlement } from '../../../../../application/models/subscriptions/billing-entitlement.model.js';
import { stripeSubscriptionSnapshots } from '../../schemas/subscriptions/stripe-subscriptions.schema.js';
import { lockBillingEntitlement } from '../../transactions/subscriptions/lock-billing-entitlement.transaction.js';

/** Reads the same committed snapshot for HTTP recovery and usage thresholds. */
export class DrizzleBillingEntitlementReader {
  // #region Constructor
  /** Receives the runner that joins an existing tenant transaction. */
  public constructor(private readonly tenant: TenantTransactionRunner<DatabaseSchema>) {}
  // #endregion

  // #region Methods
  /** Looks up only the signed tenant and rejects malformed committed limits. */
  public read(organizationId: string): Promise<BillingEntitlement | null> {
    return this.tenant.run(async (scope) => {
      if (scope.kind !== 'tenant' || scope.organizationId !== organizationId) {
        throw new Error('Billing entitlement organization does not match its tenant scope.');
      }
      await lockBillingEntitlement(scope, organizationId, 'shared');
      const [snapshot] = await scope.db
        .select({
          plan: stripeSubscriptionSnapshots.plan,
          seatLimit: stripeSubscriptionSnapshots.seats,
          storageByteLimit: stripeSubscriptionSnapshots.storageBytes,
          version: stripeSubscriptionSnapshots.version,
        })
        .from(stripeSubscriptionSnapshots)
        .where(eq(stripeSubscriptionSnapshots.organizationId, organizationId))
        .limit(1);
      if (snapshot === undefined) return null;
      if (
        ![snapshot.seatLimit, snapshot.storageByteLimit, snapshot.version].every(
          (value) => Number.isSafeInteger(value) && value > 0,
        )
      ) {
        throw new Error('The committed billing entitlement has invalid limits or version.');
      }
      return snapshot;
    });
  }
  // #endregion
}
