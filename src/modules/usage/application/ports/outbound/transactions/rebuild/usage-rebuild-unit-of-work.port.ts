import type { UsageRebuildTransaction } from './usage-rebuild-transaction.port.js';

/** Tenant-scoped transaction for generation lifecycle and source page writes. */
export interface UsageRebuildUnitOfWork {
  // #region Methods
  /** Runs the entire write in one organization-scoped transaction. */
  run<T>(
    organizationId: string,
    work: (transaction: UsageRebuildTransaction) => Promise<T>,
  ): Promise<T>;
  // #endregion
}
