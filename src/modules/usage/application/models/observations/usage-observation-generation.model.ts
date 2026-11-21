import type { UsageTotals } from '../../../domain/value-objects/observations/usage-totals.value-object.js';

/** One generation and its totals as read under the organization lock. */
export interface UsageObservationGeneration {
  // #region Properties
  /** Generation identity. */
  readonly id: string;

  /** Counters at the point the organization was locked. */
  readonly totals: UsageTotals;
  // #endregion
}
