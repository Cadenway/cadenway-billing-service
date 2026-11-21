import type { UsageRebuildBrokerProgress } from './usage-rebuild-broker-progress.model.js';

/** Independent progress and terminal-advisory observation. */
export interface UsageBrokerSample {
  // #region Properties
  /** Stream and durable state sampled at this time. */
  readonly progress: UsageRebuildBrokerProgress;

  /** Whether the persistent advisory latch was confirmed clear. */
  readonly advisoriesClear: boolean;
  // #endregion
}
