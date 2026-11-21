/** Whether a Checkout delivery is settled or should be retried. */
export type ReconcileStripeCheckoutOutput =
  | { readonly status: 'applied' | 'unchanged' | 'expired' | 'duplicate' }
  | { readonly status: 'retry' };
