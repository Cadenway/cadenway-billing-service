import { applyRecordedUsageObservation } from '../../../../../domain/policies/observations/apply-recorded-usage-observation.policy.js';
import { QuotaUsage } from '../../../../../domain/value-objects/quotas/quota-usage.value-object.js';
import type { UsageTotals } from '../../../../../domain/value-objects/observations/usage-totals.value-object.js';
import type { UsageObservationGeneration } from '../../../../models/observations/usage-observation-generation.model.js';
import type { UsageObservationTransaction } from '../../../../ports/outbound/transactions/observations/usage-observation-transaction.port.js';
import type { UsageObservationUnitOfWork } from '../../../../ports/outbound/transactions/observations/usage-observation-unit-of-work.port.js';
import type { RecordUsageObservationInput } from './record-usage-observation.input.js';
import type { RecordUsageObservationOutput } from './record-usage-observation.output.js';

/** Records a source event in every current projection and emits live quota crossings. */
export class RecordUsageObservation {
  // #region Constructor
  /** Receives the tenant transaction boundary and its bound persistence operations. */
  public constructor(private readonly unitOfWork: UsageObservationUnitOfWork) {}
  // #endregion

  // #region Methods
  /**
   * Applies source versions idempotently. Event handlers must use the kit's deduplication
   * transaction so its receipt, projection changes and outbox entries commit together.
   */
  public async execute(input: RecordUsageObservationInput): Promise<RecordUsageObservationOutput> {
    return this.unitOfWork.run(input.organizationId, async (transaction) => {
      const organization = await transaction.lockOrganization();
      let changed = false;

      if (organization.active !== null) {
        const nextTotals = await this.apply(transaction, organization.active, input);
        if (nextTotals !== null) {
          changed = true;
          const seats = new QuotaUsage(
            'seats',
            organization.active.totals.seats,
            organization.limits.seats,
          ).thresholdCrossedAt(nextTotals.seats);
          const storage = new QuotaUsage(
            'storage',
            organization.active.totals.storageBytes,
            organization.limits.storageBytes,
          ).thresholdCrossedAt(nextTotals.storageBytes);
          if (seats !== undefined) await transaction.appendThreshold(seats);
          if (storage !== undefined) await transaction.appendThreshold(storage);
        }
      }

      if (organization.candidate !== null) {
        const candidateTotals = await this.apply(transaction, organization.candidate, input);
        if (candidateTotals !== null) changed = true;
      }
      return changed ? 'recorded' : 'unchanged';
    });
  }

  private async apply(
    transaction: UsageObservationTransaction,
    generation: UsageObservationGeneration,
    input: RecordUsageObservationInput,
  ): Promise<UsageTotals | null> {
    const current = await transaction.loadObservation(
      generation.id,
      input.observation.source,
      input.observation.sourceId,
    );
    const result = applyRecordedUsageObservation(current, input.observation, generation.totals);
    if (result === null) return null;
    await transaction.saveObservation(generation.id, result.observation, result.totals);
    return result.totals;
  }
  // #endregion
}
