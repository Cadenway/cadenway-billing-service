/** A submitted reservation read in its own organization before consulting Stripe. */
export interface CheckoutRecoveryTarget {
  // #region Properties
  /** Organization from Billing's durable reservation. */
  readonly organizationId: string;

  /** Immutable client reference and provider idempotency identity. */
  readonly providerKey: string;

  /** Earliest time a provider call could have been sent. */
  readonly providerStartedAt: Date;

  /** Stripe session ID, when its response was committed by Billing. */
  readonly sessionId: string | null;

  /** Expected provider price. */
  readonly priceId: string;

  /** Billable seat quantity persisted on the original request. */
  readonly quantity: number;

  /** Absolute Stripe deadline, absent on historical requests. */
  readonly expiresAt: number | undefined;
  // #endregion
}
