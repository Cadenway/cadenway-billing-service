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

  /** Reads an observation belonging to the selected generation and tenant. */
  readonly loadObservation: (
    generationId: string,
    source: RecordedUsageObservation['source'],
    sourceId: string,
  ) => Promise<RecordedUsageObservation | null>;

  /** Persists a versioned source observation in the selected generation. */
  readonly saveObservation: (
    generationId: string,
    observation: RecordedUsageObservation,
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

  /** Invalidates the still-selected active generation only at the observed row version. */
  readonly invalidateActive: (generationId: string, expectedVersion: number) => Promise<boolean>;
  // #endregion
}
