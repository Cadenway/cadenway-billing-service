import type { UsageObservationGeneration } from './usage-observation-generation.model.js';

/** Projection pointers and current quota limits read under the organization lock. */
export interface LockedUsageOrganization {
  // #region Properties
  /** Current live projection. */
  readonly active: UsageObservationGeneration | null;

  /** Projection under reconstruction. */
  readonly candidate: UsageObservationGeneration | null;

  /** Limits for the current plan. */
  readonly limits: { readonly seats: number; readonly storageBytes: number };
  // #endregion
}
