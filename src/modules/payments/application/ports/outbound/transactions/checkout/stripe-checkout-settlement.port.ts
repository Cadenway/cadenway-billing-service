import type { StripeSubscriptionDecision } from '../../../../../domain/value-objects/subscriptions/stripe-subscription-decision.value-object.js';
import type { StripeCheckoutSession } from '../../../../models/checkout/stripe-checkout-session.model.js';

/**
 * Atomically reconciles a verified Checkout with the originating Billing reservation.
 */
export interface StripeCheckoutSettlement {
  // #region Properties
  /**
   * Locks the entitlement and originating reservation, rechecks the exact provider key,
   * session, price, quantity, mode and provider binding, and deduplicates eventId.
   * For a completed session, the binding, entitlement, outbox fact, terminal reservation
   * and receipt commit together. A deferred quota decision writes none of them.
   * For an expired session, terminal reservation and receipt commit together without a binding.
   * Every outcome is scoped to organizationId, which must come from Billing's reservation.
   */
  readonly settle: (input: {
    readonly organizationId: string;
    readonly eventId: string;
    readonly session: Exclude<StripeCheckoutSession, { readonly status: 'pending' }>;
    readonly decision: Extract<
      StripeSubscriptionDecision,
      { readonly kind: 'apply'; readonly plan: 'team' }
    > | null;
  }) => Promise<'applied' | 'unchanged' | 'expired' | 'duplicate' | 'retry'>;
  // #endregion
}
