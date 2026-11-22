import type { StripeSubscriptionReconciliation } from '../../../domain/value-objects/subscriptions/stripe-subscription-reconciliation.value-object.js';

/** Provider binding and its durable reconciliation revision for one tenant. */
export interface StripeBindingSnapshot {
  // #region Properties
  /** Monotonic revision advanced on every settlement. */
  readonly revision: number;

  /** Current authoritative provider binding. */
  readonly binding: StripeSubscriptionReconciliation['binding'];
  // #endregion
}
