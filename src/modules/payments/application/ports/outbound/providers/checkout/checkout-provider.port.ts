import type { CheckoutProviderRequest } from '../../../../models/checkout/checkout-provider-request.model.js';
import type { CheckoutRecoveryEvidence } from '../../../../models/checkout/checkout-recovery-evidence.model.js';
import type { CheckoutRecoveryTarget } from '../../../../models/checkout/checkout-recovery-target.model.js';

/** Creates a hosted checkout using the stored provider idempotency identity and parameters. */
export interface CheckoutProvider {
  // #region Properties
  /** Returns the hosted session or proof of rejection before execution; throws for uncertainty. */
  readonly create: (
    request: CheckoutProviderRequest,
  ) => Promise<
    | { readonly url: string; readonly sessionId: string }
    | { readonly status: 'rejected-before-execution' }
  >;

  /** Reads the original session without performing provider writes. */
  readonly recover: (target: CheckoutRecoveryTarget) => Promise<CheckoutRecoveryEvidence>;
  // #endregion
}
