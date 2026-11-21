import type { CheckoutProviderRequest } from '../../../../models/checkout/checkout-provider-request.model.js';
import type { CheckoutRecoveryEvidence } from '../../../../models/checkout/checkout-recovery-evidence.model.js';
import type { CheckoutRecoveryTarget } from '../../../../models/checkout/checkout-recovery-target.model.js';

/** Creates a hosted checkout using the stored provider idempotency identity and parameters. */
export interface CheckoutProvider {
  // #region Properties
  /** Returns the Stripe ID and validated hosted URL or throws for an uncertain outcome. */
  readonly create: (
    request: CheckoutProviderRequest,
  ) => Promise<{ readonly url: string; readonly sessionId: string }>;

  /** Reads the original session without performing provider writes. */
  readonly recover: (target: CheckoutRecoveryTarget) => Promise<CheckoutRecoveryEvidence>;
  // #endregion
}
