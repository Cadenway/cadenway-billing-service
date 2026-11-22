/** Authenticating a Stripe delivery yields only the facts needed to settle it. */
export type StripeWebhookAuthenticator = (
  rawBody: Uint8Array,
  signature: string,
) =>
  | {
      readonly kind: 'subscription';
      readonly eventId: string;
      readonly customerId: string;
      readonly subscriptionId: string;
    }
  | {
      readonly kind: 'checkout';
      readonly eventId: string;
      readonly sessionId: string;
      readonly providerKey?: string;
    }
  | {
      readonly kind:
        'ignored' | 'invalid-signature' | 'invalid-event' | 'body-too-large' | 'unavailable';
    };
