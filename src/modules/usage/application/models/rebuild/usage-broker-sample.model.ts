import type { UsageAdvisoryObservation } from './usage-advisory-observation.model.js';
import type { UsageRebuildBrokerProgress } from './usage-rebuild-broker-progress.model.js';

/** Independent progress and terminal-advisory observation. */
export interface UsageBrokerSample {
  // #region Properties
  /** Stream and durable state sampled at this time. */
  readonly progress: UsageRebuildBrokerProgress;

  /** Whether the persistent advisory latch was confirmed clear. */
  readonly advisoriesClear: boolean;

  /** Latch status and confirmed clear identity, when available. */
  readonly advisoryState: 'clear' | 'held' | 'unknown';
  readonly advisory: UsageAdvisoryObservation | null;
  // #endregion
}
