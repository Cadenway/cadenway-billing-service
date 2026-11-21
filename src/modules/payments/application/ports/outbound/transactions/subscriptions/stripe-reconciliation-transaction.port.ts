import type { StripeSubscriptionDecision } from '../../../../../domain/value-objects/subscriptions/stripe-subscription-decision.value-object.js';
import type { StripeSubscriptionReconciliation } from '../../../../../domain/value-objects/subscriptions/stripe-subscription-reconciliation.value-object.js';
import type { StripeBindingSnapshot } from '../../../../models/subscriptions/stripe-binding-snapshot.model.js';

/** Tenant-scoped operations sharing the same locked reconciliation transaction. */
export interface StripeReconciliationTransaction {
  // #region Properties
  /** Locks the tenant binding and its reconciliation revision. */
  readonly lockBinding: () => Promise<StripeBindingSnapshot | null>;

  /** Checks a durably accepted provider event under the tenant lock. */
  readonly isSettled: (eventId: string) => Promise<boolean>;

  /** Returns fresh, fenced usage only when a reduction can safely be evaluated. */
  readonly confirmedUsage: () => Promise<StripeSubscriptionReconciliation['confirmedUsage']>;

  /**
   * Persists the entitlement only if any reduced allowance is fenced against concurrent
   * admissions and still accommodates usage. A missing or stale proof returns deferred.
   */
  readonly apply: (
    decision: Extract<StripeSubscriptionDecision, { readonly kind: 'apply' }>,
  ) => Promise<'applied' | 'unchanged' | 'deferred'>;

  /** Records the event receipt and advances the binding revision, including for no change. */
  readonly settle: (eventId: string) => Promise<void>;
  // #endregion
}
