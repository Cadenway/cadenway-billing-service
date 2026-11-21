import type { UsageTotals } from '../../../domain/value-objects/observations/usage-totals.value-object.js';
import type { UsageRebuildBrokerProgress } from './usage-rebuild-broker-progress.model.js';

/** A candidate and its source checkpoints, read under the tenant's organization lock. */
export interface UsageRebuildCandidate {
  // #region Properties
  /** Immutable candidate identity. */
  readonly id: string;

  /** Row version sampled before the final broker observation. */
  readonly version: number;

  /** Counts including committed event observations and imported source pages. */
  readonly totals: UsageTotals;

  /** State of the membership source. */
  readonly membership: { readonly cursor: string | null; readonly complete: boolean };

  /** State of the attachment source. */
  readonly attachment: { readonly cursor: string | null; readonly complete: boolean };

  /** Broker sample captured before any authoritative source page. */
  readonly brokerAtStart: UsageRebuildBrokerProgress;
  // #endregion
}
