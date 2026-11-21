import type { ActiveUsageReader } from '../../../../ports/outbound/persistence/usage/active-usage-reader.port.js';
import type { GetBillingSubscriptionInput } from './get-billing-subscription.input.js';
import type { GetBillingSubscriptionOutput } from './get-billing-subscription.output.js';

/** Reads a plan and its initialized usage for the verified organization. */
export class GetBillingSubscription {
  // #region Constructor
  /** Receives the tenant-scoped reader and the current plan supplied by composition. */
  public constructor(
    private readonly usage: ActiveUsageReader,
    private readonly plan: {
      readonly id: 'free';
      readonly seats: number;
      readonly storageBytes: number;
    } | null,
  ) {}
  // #endregion

  // #region Methods
  /** Returns null until both the current plan and measured usage are available. */
  public async execute(
    input: GetBillingSubscriptionInput,
  ): Promise<GetBillingSubscriptionOutput | null> {
    if (this.plan === null) return null;
    const totals = await this.usage.read(input.organizationId);
    if (totals === null) return null;

    return {
      plan: this.plan.id,
      seats: { used: totals.seats, limit: this.plan.seats },
      guestCount: totals.guests,
      storage: { attachmentBytesUsed: totals.storageBytes, limitBytes: this.plan.storageBytes },
    };
  }
  // #endregion
}
