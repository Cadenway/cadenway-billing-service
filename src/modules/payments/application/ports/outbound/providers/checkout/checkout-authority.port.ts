import type { CheckoutProviderRequest } from '../../../../models/checkout/checkout-provider-request.model.js';

/** Obtains authoritative seat evidence and Billing-owned checkout configuration. */
export interface CheckoutAuthority {
  // #region Properties
  /**
   * Reads the current organization's paid seats without an open Billing transaction.
   * Returns null if authority or configuration is unavailable or the resulting entitlement
   * would decrease either committed limit. The implementation must prove seat quantity and
   * limits before allowing a provider request.
   */
  readonly prepare: (
    organizationId: string,
    providerKey: string,
  ) => Promise<CheckoutProviderRequest | null>;
  // #endregion
}
