import type { UsageRebuildBrokerProgress } from '../../../../models/rebuild/usage-rebuild-broker-progress.model.js';

/** Independent broker sample taken after both source scans completed. */
export interface PromoteUsageRebuildInput {
  // #region Properties
  /** Organization and candidate identity. */
  readonly organizationId: string;

  /** Identifier of the candidate. */
  readonly generationId: string;

  /** Version read after source completion and before sampling the broker. */
  readonly expectedCandidateVersion: number;

  /** Broker progress sampled after the final source page. */
  readonly brokerAtPromotion: UsageRebuildBrokerProgress;

  /** Whether the persistent terminal-advisory latch was confirmed clear. */
  readonly advisoriesClear: boolean;
  // #endregion
}
