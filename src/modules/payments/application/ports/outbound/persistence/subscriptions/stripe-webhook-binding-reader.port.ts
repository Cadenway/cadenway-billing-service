import type { StripeBindingSnapshot } from '../../../../models/subscriptions/stripe-binding-snapshot.model.js';

/** Resolves a verified webhook to a current Billing-owned Stripe binding. */
export interface StripeWebhookBindingReader {
  // #region Properties
  /** Matches both provider IDs within the service's configured Stripe account. */
  readonly resolve: (identity: {
    readonly account: string | null;
    readonly authContext: string | null;
    readonly customerId: string;
    readonly subscriptionId: string;
  }) => Promise<(StripeBindingSnapshot & { readonly organizationId: string }) | null>;
  // #endregion
}
