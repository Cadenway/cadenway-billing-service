/** A terminal receipt or a request to retry after current proof becomes available. */
export type ReconcileStripeSubscriptionOutput =
  | { readonly status: 'applied' | 'unchanged' | 'ignored' | 'duplicate' }
  | { readonly status: 'retry' };
