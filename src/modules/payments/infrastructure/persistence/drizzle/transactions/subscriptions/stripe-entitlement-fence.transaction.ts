import type { DatabaseSchema, TransactionScope } from '@cadenway/nest-common/database';

import type { StripeSubscriptionDecision } from '../../../../../domain/value-objects/subscriptions/stripe-subscription-decision.value-object.js';

/** Authorizes and records entitlement changes within the Billing transaction. */
export interface StripeEntitlementFence {
  // #region Properties
  /** Appends the change fact in the same transaction when the transition is allowed. */
  readonly authorizeChange: (
    scope: TransactionScope<DatabaseSchema>,
    organizationId: string,
    previous: Extract<StripeSubscriptionDecision, { readonly kind: 'apply' }> | null,
    next: Extract<StripeSubscriptionDecision, { readonly kind: 'apply' }>,
    nextVersion: number,
  ) => Promise<boolean>;
  // #endregion
}
