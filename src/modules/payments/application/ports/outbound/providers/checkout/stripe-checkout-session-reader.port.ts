import type { StripeCheckoutSession } from '../../../../models/checkout/stripe-checkout-session.model.js';

/** Reads current Checkout state using Billing's configured Stripe account. */
export interface StripeCheckoutSessionReader {
  // #region Properties
  /** Retrieves one session without using tenant identity from its webhook. */
  readonly retrieve: (sessionId: string) => Promise<StripeCheckoutSession>;
  // #endregion
}
