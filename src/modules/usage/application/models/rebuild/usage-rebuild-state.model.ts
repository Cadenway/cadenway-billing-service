import type { ActiveUsageGeneration } from './active-usage-generation.model.js';
import type { UsageRebuildCandidate } from './usage-rebuild-candidate.model.js';

/** Current generation pointers observed in the same tenant snapshot. */
export interface UsageRebuildState {
  // #region Properties
  /** Current ready generation, if any. */
  readonly active: ActiveUsageGeneration | null;

  /** Selected building generation, if any. */
  readonly candidate: UsageRebuildCandidate | null;
  // #endregion
}
