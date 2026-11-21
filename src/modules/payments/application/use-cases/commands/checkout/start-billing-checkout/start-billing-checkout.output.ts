/** An accepted checkout URL or a safe, contract-mapped failure. */
export type StartBillingCheckoutOutput =
  | { readonly status: 'ready'; readonly url: string }
  | {
      readonly status:
        | 'subscription-active'
        | 'checkout-in-progress'
        | 'request-in-progress'
        | 'key-reused'
        | 'unavailable';
    };
