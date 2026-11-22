import type { StripeBindingSnapshot } from '../../../../models/subscriptions/stripe-binding-snapshot.model.js';

/** Looks up the account-wide receipt and current binding of a verified Stripe event. */
export interface StripeWebhookBindingReader {
  // #region Properties
  /** Checks the durable receipt without returning the organization that settled the event. */
  readonly hasSettlement: (eventId: string) => Promise<boolean>;

  /** Matches both provider IDs within the service's configured Stripe account. */
  readonly resolve: (identity: {
    readonly account: string | null;
    readonly authContext: string | null;
    readonly customerId: string;
    readonly subscriptionId: string;
  }) => Promise<(StripeBindingSnapshot & { readonly organizationId: string }) | null>;
  // #endregion
}
