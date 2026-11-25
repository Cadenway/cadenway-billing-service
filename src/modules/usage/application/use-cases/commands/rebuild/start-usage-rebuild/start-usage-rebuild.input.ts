import type { UsageAdvisoryObservation } from '../../../../models/rebuild/usage-advisory-observation.model.js';
import type { UsageRebuildBrokerProgress } from '../../../../models/rebuild/usage-rebuild-broker-progress.model.js';

/** Inputs collected before scanning any authoritative data. */
export interface StartUsageRebuildInput {
  // #region Properties
  /** Organization established by the calling system context. */
  readonly organizationId: string;

  /** Independently observed stream and durable state. */
  readonly brokerAtStart: UsageRebuildBrokerProgress;

  /** Whether the persistent terminal-advisory latch was confirmed clear. */
  readonly advisoriesClear: boolean;

  /** Confirmed clear latch identity. */
  readonly advisory: UsageAdvisoryObservation | null;
  // #endregion
}
