import type { UsageAdvisoryObservation } from './usage-advisory-observation.model.js';
import type { UsageRebuildBrokerProgress } from './usage-rebuild-broker-progress.model.js';

/** A ready generation together with its promotion checkpoint. */
export interface ActiveUsageGeneration {
  // #region Properties
  /** Selected generation identifier. */
  readonly id: string;

  /** Current row version for invalidation. */
  readonly version: number;

  /** Event progress recorded when the generation was promoted. */
  readonly brokerAtPromotion: UsageRebuildBrokerProgress;

  /** Certified latch identity, absent on legacy generations. */
  readonly advisory: UsageAdvisoryObservation | null;
  // #endregion
}
