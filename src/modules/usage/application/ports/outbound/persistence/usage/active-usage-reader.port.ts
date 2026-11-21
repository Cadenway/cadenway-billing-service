import type { UsageTotals } from '../../../../../domain/value-objects/observations/usage-totals.value-object.js';

/** Reads measured usage from the signed organization's active projection. */
export interface ActiveUsageReader {
  // #region Methods
  /** Returns null until a ready generation is available for this organization. */
  read(organizationId: string): Promise<UsageTotals | null>;
  // #endregion
}
