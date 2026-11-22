import type { CheckoutProviderRequest } from '../../../../models/checkout/checkout-provider-request.model.js';
import type { CheckoutClaim } from '../../../../models/checkout/checkout-claim.model.js';
import type { CheckoutRecoveryTarget } from '../../../../models/checkout/checkout-recovery-target.model.js';
import type { FirstCheckoutDispatch } from '../../../../models/checkout/first-checkout-dispatch.model.js';
import type { StartBillingCheckoutInput } from '../../../../use-cases/commands/checkout/start-billing-checkout/start-billing-checkout.input.js';

/** Tenant transaction for a durable checkout reservation and its response. */
export interface CheckoutUnitOfWork {
  // #region Properties
  /**
   * Serializes the actor, organization and key with the organization's active checkout.
   * Replays a committed response for 24 hours, detects a different body for the same key,
   * and leases one attempt. A lease also permits read-only recovery past the dispatch window.
   */
  readonly claim: (input: StartBillingCheckoutInput) => Promise<CheckoutClaim>;

  /**
   * Authorizes external I/O under the active lease, after rechecking the committed
   * subscription and the provider idempotency window. Persists the first request
   * or verifies that all immutable parameters match the existing request. Only the first
   * dispatch can be conclusively rejected without a provider session.
   */
  readonly saveRequest: (
    organizationId: string,
    token: string,
    request: CheckoutProviderRequest,
  ) => Promise<FirstCheckoutDispatch | { readonly status: 'retry' } | null>;

  /** Resolves a conclusively rejected first dispatch only while its exact lease and version hold. */
  readonly resolveRejected: (
    organizationId: string,
    token: string,
    providerKey: string,
    dispatch: FirstCheckoutDispatch,
  ) => Promise<boolean>;

  /**
   * Records the exact response for replay and releases this lease atomically.
   * A stale token returns false and cannot overwrite another attempt.
   */
  readonly complete: (
    organizationId: string,
    token: string,
    url: string,
    sessionId?: string,
  ) => Promise<boolean>;

  /** Finds only the organization's unresolved submitted attempt for positive recovery. */
  readonly findUnresolved: (organizationId: string) => Promise<CheckoutRecoveryTarget | null>;

  /** Releases only the specified lease while keeping the reservation and provider parameters. */
  readonly release: (organizationId: string, token: string) => Promise<void>;
  // #endregion
}
