/** Resolves only a Billing-generated provider key to its owning reservation. */
export interface StripeCheckoutAttemptReader {
  // #region Properties
  /** Reads an account-wide durable Checkout receipt before provider access. */
  readonly hasSettlement: (eventId: string) => Promise<boolean>;

  /** Resolves an untrusted provider key against Billing's own durable reservation. */
  readonly resolve: (providerKey: string) => Promise<{ readonly organizationId: string } | null>;
  // #endregion
}
