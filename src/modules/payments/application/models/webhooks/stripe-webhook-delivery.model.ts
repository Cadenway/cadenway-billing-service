/** A verified Stripe identity with a tenant resolved from Billing's provider records. */
export type StripeWebhookDelivery = {
  readonly organizationId: string;
  readonly eventId: string;
} & (
  | { readonly kind: 'checkout'; readonly sessionId: string }
  | {
      readonly kind: 'subscription';
      readonly customerId: string;
      readonly subscriptionId: string;
    }
);
