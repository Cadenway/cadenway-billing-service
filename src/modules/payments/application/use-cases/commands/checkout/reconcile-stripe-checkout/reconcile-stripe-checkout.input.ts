/** An authenticated Stripe Checkout delivery containing no tenant authority. */
export interface ReconcileStripeCheckoutInput {
  // #region Properties
  /** Stripe event identifier for deduplication. */
  readonly eventId: string;

  /** The Checkout session to retrieve with Billing's Stripe credentials. */
  readonly sessionId: string;

  /** An inbox delivery remains bound to the tenant established at admission. */
  readonly expectedOrganizationId?: string;
  // #endregion
}
