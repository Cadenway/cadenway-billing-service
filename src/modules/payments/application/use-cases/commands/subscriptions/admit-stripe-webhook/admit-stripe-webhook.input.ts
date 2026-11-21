/** Original provider bytes forwarded by the gateway and their signature. */
export interface AdmitStripeWebhookInput {
  // #region Properties
  /** Contains exactly the bytes covered by the provider signature. */
  readonly rawBody: Uint8Array;

  /** A single Stripe-Signature header. */
  readonly signature: string;
  // #endregion
}
