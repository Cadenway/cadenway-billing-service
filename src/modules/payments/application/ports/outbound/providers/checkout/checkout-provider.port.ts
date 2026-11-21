import type { CheckoutProviderRequest } from '../../../../models/checkout/checkout-provider-request.model.js';

/** Creates a hosted checkout using the stored provider idempotency identity and parameters. */
export interface CheckoutProvider {
  // #region Properties
  /** Returns a trusted, validated HTTPS checkout URL or throws for an uncertain outcome. */
  readonly create: (request: CheckoutProviderRequest) => Promise<string>;
  // #endregion
}
