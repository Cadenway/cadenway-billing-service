import type { RecordedUsageObservation } from '../../../../../domain/value-objects/observations/recorded-usage-observation.value-object.js';

/** One validated page fetched outside the tenant write transaction. */
export interface ApplyUsageRebuildPageInput {
  // #region Properties
  /** Signed source organization and candidate identity. */
  readonly organizationId: string;

  /** Identifier of the selected candidate. */
  readonly generationId: string;

  /** Source from which this page was fetched. */
  readonly source: RecordedUsageObservation['source'];

  /** Checkpoint used to fetch this page. */
  readonly expectedCursor: string | null;

  /** Null means the source scan has finished. */
  readonly nextCursor: string | null;

  /** At most 100 versioned observations from that source. */
  readonly items: readonly RecordedUsageObservation[];
  // #endregion
}
