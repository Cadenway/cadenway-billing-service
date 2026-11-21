import { QuotaUsageError } from '../../errors/quotas/quota-usage.error.js';
import type { QuotaThresholdReached } from '../../events/quotas/quota-threshold-reached.event.js';

import type { QuotaMetric } from './quota-metric.value-object.js';

const warningThresholdPercent = 80;

/**
 * An observed quota counter can exceed the included capacity. P5 decision G and the limits in
 * Organisation › Quotas et usage apply when admitting increases. Existing usage can be reconciled
 * or reduced while above the limit.
 */
export class QuotaUsage {
  // #region Constructor
  /** Validates the measured baseline and limit in seats or bytes. */
  public constructor(
    public readonly metric: QuotaMetric,
    public readonly used: number,
    public readonly limit: number,
  ) {
    assertValidUsage(metric, used);
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new QuotaUsageError(metric, 'invalid-limit');
    }
  }
  // #endregion

  // #region Methods
  /** Refuses an increase above the limit and permits valid reductions and no-ops. */
  public assertCanChangeTo(nextUsed: number): void {
    assertValidUsage(this.metric, nextUsed);
    if (nextUsed > this.used && nextUsed > this.limit) {
      throw new QuotaUsageError(this.metric, 'quota-exceeded');
    }
  }

  /** Returns the notification fact only when observed usage crosses 80 percent upwards. */
  public thresholdCrossedAt(nextUsed: number): QuotaThresholdReached | undefined {
    assertValidUsage(this.metric, nextUsed);
    const threshold = BigInt(this.limit) * BigInt(warningThresholdPercent);
    if (BigInt(this.used) * 100n >= threshold || BigInt(nextUsed) * 100n < threshold) {
      return undefined;
    }
    return {
      metric: this.metric,
      used: nextUsed,
      limit: this.limit,
      thresholdPercent: warningThresholdPercent,
    };
  }
  // #endregion
}

function assertValidUsage(metric: QuotaMetric, used: number): void {
  if (!Number.isSafeInteger(used) || used < 0) {
    throw new QuotaUsageError(metric, 'invalid-usage');
  }
}
