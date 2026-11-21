/** A gateway-authenticated owner request with a validated checkout key and body. */
export interface StartBillingCheckoutInput {
  // #region Properties
  /** Organization from the authenticated request context. */
  readonly organizationId: string;

  /** User from the authenticated request context. */
  readonly actorId: string;

  /** Client-provided key for replaying this request. */
  readonly idempotencyKey: string;

  /** Validated requested plan. */
  readonly plan: 'team';
  // #endregion
}
