import type { QuotaMetric } from '../../value-objects/quotas/quota-metric.value-object.js';

abstract class DomainError extends Error {}

/** Refusal of an invalid quota measurement or an increase exceeding the allowed limit. */
export class QuotaUsageError extends DomainError {
  // #region Properties
  /** Identifies a domain quota refusal in error reporting. */
  public override readonly name = 'QuotaUsageError';
  // #endregion

  // #region Constructor
  /** Retains the units and reason so the caller can map the refusal without parsing a message. */
  public constructor(
    public readonly metric: QuotaMetric,
    public readonly reason: 'invalid-usage' | 'invalid-limit' | 'quota-exceeded',
  ) {
    super(`Quota change refused for ${metric} (${reason}).`);
  }
  // #endregion
}
