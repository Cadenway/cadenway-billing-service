import type { CheckoutProviderRequest } from './checkout-provider-request.model.js';

/** Result of atomically locking or creating a tenant's checkout reservation. */
export type CheckoutClaim =
  | { readonly status: 'replay'; readonly url: string }
  | {
      readonly status: 'claimed';
      readonly token: string;
      readonly providerKey: string;
      readonly customerId?: string;
      readonly request: CheckoutProviderRequest | null;
    }
  | {
      readonly status:
        | 'subscription-active'
        | 'checkout-in-progress'
        | 'request-in-progress'
        | 'key-reused'
        | 'unavailable';
    };
