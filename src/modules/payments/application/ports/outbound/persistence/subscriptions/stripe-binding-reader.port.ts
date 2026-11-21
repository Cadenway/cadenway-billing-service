import type { StripeBindingSnapshot } from '../../../../models/subscriptions/stripe-binding-snapshot.model.js';

/** Reads a tenant's locally verified current Stripe binding. */
export interface StripeBindingReader {
  // #region Properties
  /** Reads a binding for the specified tenant. */
  readonly read: (organizationId: string) => Promise<StripeBindingSnapshot | null>;
  // #endregion
}
