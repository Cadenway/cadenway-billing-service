interface Limits {
  // #region Properties
  /** Licensed seats. */
  readonly seats: number;

  /** Storage allowance, in bytes. */
  readonly storageBytes: number;
  // #endregion
}

/** The entitlement to apply or the reason to keep the current entitlement. */
export type StripeSubscriptionDecision =
  | {
      readonly kind: 'apply';
      readonly plan: 'team';
      readonly limits: Limits;
      readonly scheduledCancellation: boolean;
    }
  | { readonly kind: 'apply'; readonly plan: 'free'; readonly limits: Limits }
  | { readonly kind: 'ignore'; readonly reason: 'binding-mismatch' | 'initial-payment-pending' }
  | {
      readonly kind: 'reconcile';
      readonly reason:
        | 'unresolved-status'
        | 'unexpected-team-items'
        | 'free-quota-unverified'
        | 'free-quota-exceeded';
    };
