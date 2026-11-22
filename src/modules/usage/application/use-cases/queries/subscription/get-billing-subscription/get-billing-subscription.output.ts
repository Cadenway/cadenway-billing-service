/** Current subscription and measured usage returned by the query. */
export interface GetBillingSubscriptionOutput {
  // #region Properties
  /** Current plan identifier. */
  readonly plan: 'free' | 'team';

  /** Active billed seats and the plan limit. */
  readonly seats: { readonly used: number; readonly limit: number };

  /** Active guests, counted independently of billed seats. */
  readonly guestCount: number;

  /** Verified ready attachment bytes and the plan limit. */
  readonly storage: { readonly attachmentBytesUsed: number; readonly limitBytes: number };
  // #endregion
}
