import type { DatabaseSchema, TransactionScope } from '@cadenway/nest-common/database';

import type { StripeSubscriptionDecision } from '../../../../../domain/value-objects/subscriptions/stripe-subscription-decision.value-object.js';
import type { StripeSubscriptionReconciliation } from '../../../../../domain/value-objects/subscriptions/stripe-subscription-reconciliation.value-object.js';

/** Local, transaction-bound quota proof and outbox coordination for entitlement changes. */
export interface StripeEntitlementFence {
  // #region Properties
  /** Returns a current usage proof from local, fenced evidence, or null when unavailable. */
  readonly confirmedUsage: (
    scope: TransactionScope<DatabaseSchema>,
    organizationId: string,
  ) => Promise<StripeSubscriptionReconciliation['confirmedUsage']>;

  /** Fences admissions and appends the change fact in this same transaction, or defers. */
  readonly authorizeChange: (
    scope: TransactionScope<DatabaseSchema>,
    organizationId: string,
    previous: Extract<StripeSubscriptionDecision, { readonly kind: 'apply' }> | null,
    next: Extract<StripeSubscriptionDecision, { readonly kind: 'apply' }>,
    nextVersion: number,
  ) => Promise<boolean>;
  // #endregion
}
