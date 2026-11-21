abstract class DomainError extends Error {}

/** An observation cannot be reconciled with the persisted usage projection. */
export class RecordedUsageObservationError extends DomainError {
  // #region Properties
  /** Identifies an inconsistent observation or counter in error reporting. */
  public override readonly name = 'RecordedUsageObservationError';
  // #endregion

  // #region Constructor
  /** Retains the violated invariant for structured error handling. */
  public constructor(public readonly reason: 'mismatched-locator' | 'invalid-totals') {
    super(`Cannot reconcile the recorded usage observation (${reason}).`);
  }
  // #endregion
}
