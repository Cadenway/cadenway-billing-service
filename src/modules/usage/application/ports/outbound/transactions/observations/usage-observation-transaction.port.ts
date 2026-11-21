import type { QuotaThresholdReached } from '../../../../../domain/events/quotas/quota-threshold-reached.event.js';
import type { RecordedUsageObservation } from '../../../../../domain/value-objects/observations/recorded-usage-observation.value-object.js';
import type { UsageTotals } from '../../../../../domain/value-objects/observations/usage-totals.value-object.js';
import type { LockedUsageOrganization } from '../../../../models/observations/locked-usage-organization.model.js';

/** Operations bound to the same organization-scoped database transaction. */
export interface UsageObservationTransaction {
  // #region Properties
  /** Creates the root when needed and holds its row lock until commit. */
  readonly lockOrganization: () => Promise<LockedUsageOrganization>;

  /** Reads this source locator in the requested generation. */
  readonly loadObservation: (
    generationId: string,
    source: RecordedUsageObservation['source'],
    sourceId: string,
  ) => Promise<RecordedUsageObservation | null>;

  /** Saves the observation and replacement totals together. */
  readonly saveObservation: (
    generationId: string,
    observation: RecordedUsageObservation,
    totals: UsageTotals,
  ) => Promise<void>;

  /** Advances the metric version and records the fact in the transaction-bound outbox. */
  readonly appendThreshold: (fact: QuotaThresholdReached) => Promise<void>;
  // #endregion
}
