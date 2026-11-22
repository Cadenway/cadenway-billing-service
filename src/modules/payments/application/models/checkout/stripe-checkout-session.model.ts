/** Canonical Stripe Checkout state retrieved by Billing after verifying the delivery. */
export type StripeCheckoutSession =
  | {
      readonly status: 'complete';
      readonly sessionId: string;
      readonly providerKey: string;
      readonly liveMode: boolean;
      readonly customerId: string;
      readonly subscriptionId: string;
      readonly priceId: string;
      readonly quantity: number;
    }
  | {
      readonly status: 'expired';
      readonly sessionId: string;
      readonly providerKey: string;
      readonly liveMode: boolean;
      readonly customerId?: string;
    }
  | { readonly status: 'pending' };
