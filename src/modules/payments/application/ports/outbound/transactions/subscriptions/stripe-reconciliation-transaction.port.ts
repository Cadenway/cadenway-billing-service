import type { StripeSubscriptionDecision } from '../../../../../domain/value-objects/subscriptions/stripe-subscription-decision.value-object.js';
import type { StripeBindingSnapshot } from '../../../../models/subscriptions/stripe-binding-snapshot.model.js';

/** Tenant-scoped operations sharing the same locked reconciliation transaction. */
export interface StripeReconciliationTransaction {
  // #region Properties
  /** Locks the tenant binding and its reconciliation revision. */
  readonly lockBinding: () => Promise<StripeBindingSnapshot | null>;

  /** Checks a durably accepted provider event under the tenant lock. */
  readonly isSettled: (eventId: string) => Promise<boolean>;

  /** Persists an authorized snapshot and appends its versioned entitlement event. */
  readonly apply: (
    decision: Extract<StripeSubscriptionDecision, { readonly kind: 'apply' }>,
  ) => Promise<'applied' | 'unchanged' | 'deferred'>;

  /** Records the event receipt and advances the binding revision, including for no change. */
  readonly settle: (eventId: string) => Promise<void>;
  // #endregion
}
