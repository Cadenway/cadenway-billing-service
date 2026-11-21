import type { CheckoutProviderRequest } from '../../../../models/checkout/checkout-provider-request.model.js';
import type { CheckoutClaim } from '../../../../models/checkout/checkout-claim.model.js';
import type { StartBillingCheckoutInput } from '../../../../use-cases/commands/checkout/start-billing-checkout/start-billing-checkout.input.js';

/** Tenant transaction for a durable checkout reservation and its response. */
export interface CheckoutUnitOfWork {
  // #region Properties
  /**
   * Serializes the actor, organization and key with the organization's active checkout.
   * Replays a committed response for 24 hours, detects a different body for the same key,
   * and leases one attempt. An uncertain provider call past its provider idempotency
   * retention must return unavailable instead of being dispatched again.
   */
  readonly claim: (input: StartBillingCheckoutInput) => Promise<CheckoutClaim>;

  /**
   * Authorizes external I/O under the active lease, after rechecking the committed
   * subscription and the provider idempotency window. Persists the first request
   * or verifies that all immutable parameters match the existing request.
   */
  readonly saveRequest: (
    organizationId: string,
    token: string,
    request: CheckoutProviderRequest,
  ) => Promise<boolean>;

  /**
   * Records the exact response for replay and releases this lease atomically.
   * A stale token returns false and cannot overwrite another attempt.
   */
  readonly complete: (organizationId: string, token: string, url: string) => Promise<boolean>;

  /** Releases only the specified lease while keeping the reservation and provider parameters. */
  readonly release: (organizationId: string, token: string) => Promise<void>;
  // #endregion
}
