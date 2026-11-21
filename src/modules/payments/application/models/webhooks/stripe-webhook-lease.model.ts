import type { StripeWebhookDelivery } from './stripe-webhook-delivery.model.js';

/** Owns one attempt until the inbox lease expires or is explicitly resolved. */
export interface StripeWebhookLease {
  // #region Properties
  /** Authenticated event identity and its admitted tenant. */
  readonly delivery: StripeWebhookDelivery;
  readonly token: string;
  readonly attempt: number;
  readonly admittedAt: Date;
  // #endregion
}
