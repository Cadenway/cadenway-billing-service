import type { StripeWebhookDelivery } from '../../../../models/webhooks/stripe-webhook-delivery.model.js';
import type { StripeWebhookLease } from '../../../../models/webhooks/stripe-webhook-lease.model.js';

/** Durably admits verified provider identities and coordinates leased processing. */
export interface StripeWebhookInbox {
  // #region Methods
  /** Returns true once this exact delivery is committed or already recorded. */
  enqueue(delivery: StripeWebhookDelivery): Promise<boolean>;

  /** Claims at most one due delivery and commits before calling the provider. */
  claim(): Promise<StripeWebhookLease | null>;

  /** Updates only the current lease. A deliberate retry never discards the delivery. */
  finish(lease: StripeWebhookLease, outcome: 'settled' | 'retry'): Promise<boolean>;
  // #endregion
}
