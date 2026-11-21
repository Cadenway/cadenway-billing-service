import type { UsageRebuildBrokerProgress } from '../../../../models/rebuild/usage-rebuild-broker-progress.model.js';

/** Pure verification of observations collected independently from JetStream. */
export interface UsageBrokerProof {
  // #region Properties
  /** Rejects a missing or malformed starting observation or an unclear advisory latch. */
  readonly validStart: (start: UsageRebuildBrokerProgress, advisoriesClear: boolean) => boolean;

  /** Validates stream and durable identity, retained coverage, and acknowledgement progress. */
  readonly assess: (
    start: UsageRebuildBrokerProgress,
    finish: UsageRebuildBrokerProgress,
    advisoriesClear: boolean,
  ) => 'covered' | 'pending' | 'lost';
  // #endregion
}
