import type { UsageObservationTransaction } from './usage-observation-transaction.port.js';

/** A tenant-scoped transaction for recording one source observation. */
export interface UsageObservationUnitOfWork {
  // #region Methods
  /**
   * Opens or joins a transaction whose scope is the supplied organization. Event handlers must
   * join the kit's transaction so its processed-event receipt commits with these writes.
   */
  run<T>(
    organizationId: string,
    work: (transaction: UsageObservationTransaction) => Promise<T>,
  ): Promise<T>;
  // #endregion
}
