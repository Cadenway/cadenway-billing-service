/** Provider observations for the original reservation. Only positive evidence can advance it. */
export type CheckoutRecoveryEvidence =
  | { readonly status: 'open'; readonly sessionId: string; readonly url: string }
  | { readonly status: 'terminal'; readonly sessionId: string }
  | { readonly status: 'unknown' };
