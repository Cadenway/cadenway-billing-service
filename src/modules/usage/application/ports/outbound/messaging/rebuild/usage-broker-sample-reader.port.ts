import type { UsageBrokerSample } from '../../../../models/rebuild/usage-broker-sample.model.js';

/** Samples broker continuity outside a database transaction. */
export interface UsageBrokerSampleReader {
  // #region Methods
  /** Returns null when the broker state cannot be established. */
  read(signal?: AbortSignal): Promise<UsageBrokerSample | null>;
  // #endregion
}
