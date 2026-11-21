import type { QuotaMetric } from '../../value-objects/quotas/quota-metric.value-object.js';

/**
 * Measured usage crossed the 80 percent notification threshold for a quota.
 * Organisation › Quotas et usage uses this threshold for email and notifications.
 */
export interface QuotaThresholdReached {
  // #region Properties
  /** Identifies the quota and the units of its two values. */
  readonly metric: QuotaMetric;

  /** Observed usage after the crossing. */
  readonly used: number;

  /** Included capacity against which the crossing was measured. */
  readonly limit: number;

  /** The notification threshold reached by this change. */
  readonly thresholdPercent: 80;
  // #endregion
}
