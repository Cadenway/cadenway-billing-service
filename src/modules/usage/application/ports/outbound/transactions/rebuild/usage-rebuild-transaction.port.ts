import type { RecordedUsageObservation } from '../../../../../domain/value-objects/observations/recorded-usage-observation.value-object.js';
import type { UsageTotals } from '../../../../../domain/value-objects/observations/usage-totals.value-object.js';
import type { UsageRebuildBrokerProgress } from '../../../../models/rebuild/usage-rebuild-broker-progress.model.js';
import type { UsageRebuildCandidate } from '../../../../models/rebuild/usage-rebuild-candidate.model.js';

/** Persistence operations bound to the locked tenant rebuild transaction. */
export interface UsageRebuildTransaction {
  // #region Properties
  /** Creates the root if absent and locks it until this transaction finishes. */
  readonly lockOrganization: () => Promise<void>;

  /** Reads the currently selected building generation. */
  readonly candidate: () => Promise<UsageRebuildCandidate | null>;

  /** Creates and selects an empty candidate with the supplied starting observation. */
  readonly startCandidate: (brokerAtStart: UsageRebuildBrokerProgress) => Promise<string>;

  /** Reads the page's existing observations for its source, generation and tenant. */
  readonly loadObservations: (
    generationId: string,
    source: RecordedUsageObservation['source'],
    sourceIds: readonly string[],
  ) => Promise<readonly RecordedUsageObservation[]>;

  /** Persists the accepted observations in the selected generation. */
  readonly saveObservations: (
    generationId: string,
    observations: readonly RecordedUsageObservation[],
  ) => Promise<void>;

  /** Commits the new totals and source cursor in the same transaction as the observations. */
  readonly savePage: (
    generationId: string,
    source: RecordedUsageObservation['source'],
    totals: UsageTotals,
    nextCursor: string | null,
  ) => Promise<void>;

  /** Atomically promotes this candidate after rechecking its organization and status. */
  readonly promote: (
    generationId: string,
    brokerAtPromotion: UsageRebuildBrokerProgress,
  ) => Promise<void>;

  /** Marks a candidate invalid and clears its pointer. The previous active generation remains. */
  readonly abandon: (generationId: string) => Promise<void>;

  /** Invalidates the still-selected generation, optionally checking its observed row version. */
  readonly invalidateActive: (
    generationId: string,
    expectedVersion: number | null,
  ) => Promise<boolean>;

  /** Records a covered broker frontier for the still-current active row version. */
  readonly checkpointActive: (
    generationId: string,
    expectedVersion: number,
    progress: UsageRebuildBrokerProgress,
  ) => Promise<boolean>;

  /** Publishes valid pending crossings only for the still-current active generation and version. */
  readonly flushThresholdIntents: (
    generationId: string,
    expectedVersion: number,
  ) => Promise<boolean>;
  // #endregion
}
