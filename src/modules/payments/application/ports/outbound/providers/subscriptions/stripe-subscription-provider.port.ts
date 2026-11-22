import type { StripeSubscriptionReconciliation } from '../../../../../domain/value-objects/subscriptions/stripe-subscription-reconciliation.value-object.js';

/** Reads current provider state using Billing's Stripe credentials. */
export interface StripeSubscriptionProvider {
  // #region Properties
  /** Reads an authoritative current subscription by its bound provider identifier. */
  readonly retrieve: (
    subscriptionId: string,
  ) => Promise<StripeSubscriptionReconciliation['subscription']>;
  // #endregion
}
