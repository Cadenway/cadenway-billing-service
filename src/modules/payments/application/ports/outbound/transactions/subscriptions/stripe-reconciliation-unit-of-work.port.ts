import type { StripeReconciliationTransaction } from './stripe-reconciliation-transaction.port.js';

/** Opens a tenant transaction for one provider reconciliation settlement. */
export interface StripeReconciliationUnitOfWork {
  // #region Properties
  /** Runs all operations under the specified organization's transaction. */
  readonly run: <T>(
    organizationId: string,
    work: (transaction: StripeReconciliationTransaction) => Promise<T>,
  ) => Promise<T>;
  // #endregion
}
