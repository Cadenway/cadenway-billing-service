import type { RecordedUsageObservation } from '../../../../../domain/value-objects/observations/recorded-usage-observation.value-object.js';

/** A validated source observation with its signed organization context. */
export interface RecordUsageObservationInput {
  // #region Properties
  /** Organization from the verified event context. */
  readonly organizationId: string;

  /** Versioned source state. */
  readonly observation: RecordedUsageObservation;
  // #endregion
}
