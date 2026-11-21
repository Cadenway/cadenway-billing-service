/** Evidence for deriving an entitlement from the current Stripe subscription. */
export interface StripeSubscriptionReconciliation {
  // #region Properties
  /** Billing's active binding from a completed and payment-confirmed or trial Checkout. */
  readonly binding: {
    readonly customerId: string;
    readonly subscriptionId: string;
  };

  /** Server settings and the Free allowance supplied by the Plans module. */
  readonly settings: {
    readonly liveMode: boolean;
    readonly teamPriceIds: readonly string[];
    readonly freePlanLimits: { readonly seats: number; readonly storageBytes: number };
  };

  /** A normalized subscription retrieved with Billing's Stripe credentials during reconciliation. */
  readonly subscription: {
    readonly customerId: string;
    readonly subscriptionId: string;
    readonly liveMode: boolean;
    readonly status: string;
    readonly scheduledCancellation: boolean;
    readonly collectionPaused: boolean;
    readonly hasMoreItems: boolean;
    readonly items: readonly { readonly priceId: string; readonly quantity: number | null }[];
  };

  /** Current seat and attachment usage. Null means the downgrade cannot be evaluated. */
  readonly confirmedUsage: { readonly seats: number; readonly storageBytes: number } | null;
  // #endregion
}
