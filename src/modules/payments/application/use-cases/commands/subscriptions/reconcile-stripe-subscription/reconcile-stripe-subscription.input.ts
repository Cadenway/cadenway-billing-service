/** A verified and durably admitted Stripe event resolved to its Billing-owned tenant. */
export interface ReconcileStripeSubscriptionInput {
  // #region Properties
  /** Tenant resolved from Billing's trusted provider binding. */
  readonly organizationId: string;

  /** Verified provider event identity recorded before asynchronous processing. */
  readonly eventId: string;
  // #endregion
}
