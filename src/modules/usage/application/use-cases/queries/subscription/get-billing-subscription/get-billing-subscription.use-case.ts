import type { ActiveUsageReader } from '../../../../ports/outbound/persistence/usage/active-usage-reader.port.js';
import type { ReadUsagePlan } from '../../../../ports/outbound/persistence/usage/read-usage-plan.port.js';
import type { GetBillingSubscriptionInput } from './get-billing-subscription.input.js';
import type { GetBillingSubscriptionOutput } from './get-billing-subscription.output.js';

/** Reads a plan and its initialized usage for the verified organization. */
export class GetBillingSubscription {
  // #region Constructor
  /** Receives the measured-usage and committed-plan readers. */
  public constructor(
    private readonly usage: ActiveUsageReader,
    private readonly readPlan: ReadUsagePlan['read'] | null,
  ) {}
  // #endregion

  // #region Methods
  /** Returns null until both the current plan and measured usage are available. */
  public async execute(
    input: GetBillingSubscriptionInput,
  ): Promise<GetBillingSubscriptionOutput | null> {
    if (this.readPlan === null) return null;
    const totals = await this.usage.read(input.organizationId);
    if (totals === null) return null;
    const plan = await this.readPlan(input.organizationId);

    return {
      plan: plan.plan,
      seats: { used: totals.seats, limit: plan.seatLimit },
      guestCount: totals.guests,
      storage: { attachmentBytesUsed: totals.storageBytes, limitBytes: plan.storageByteLimit },
    };
  }
  // #endregion
}
