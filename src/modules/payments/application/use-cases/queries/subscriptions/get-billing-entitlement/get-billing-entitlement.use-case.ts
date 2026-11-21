import type { BillingEntitlement } from '../../../../models/subscriptions/billing-entitlement.model.js';
import type { GetBillingEntitlementInput } from './get-billing-entitlement.input.js';

/** Reads the effective limits independently of provider availability and measured usage. */
export class GetBillingEntitlement {
  // #region Constructor
  /** Receives the authoritative snapshot reader and legacy baseline. */
  public constructor(
    private readonly readCommitted: (organizationId: string) => Promise<BillingEntitlement | null>,
    private readonly legacy: BillingEntitlement,
  ) {}
  // #endregion

  // #region Methods
  /** Uses version zero only after a successful query returns no committed snapshot. */
  public async execute(input: GetBillingEntitlementInput): Promise<BillingEntitlement> {
    return (await this.readCommitted(input.organizationId)) ?? this.legacy;
  }
  // #endregion
}
