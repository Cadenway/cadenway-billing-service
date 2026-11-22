import type { StripeBindingSnapshot } from '../../../../models/subscriptions/stripe-binding-snapshot.model.js';

/** A verified Stripe delivery and its Billing-owned binding. */
export interface ReconcileStripeSubscriptionInput {
  // #region Properties
  /** Tenant resolved from Billing's trusted provider binding. */
  readonly organizationId: string;

  /** Verified provider event identity used for the durable settlement receipt. */
  readonly eventId: string;

  /** Exact provider pair and revision discovered when admitting the event. */
  readonly acceptedBinding: StripeBindingSnapshot;
  // #endregion
}
