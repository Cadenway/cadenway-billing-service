abstract class DomainError extends Error {}

/** A source read refusal carrying only a reason safe for the caller to report. */
export class UsageSnapshotReadError extends DomainError {
  // #region Properties
  /** Identifies the sanitized refusal in error reporting. */
  public override readonly name = 'UsageSnapshotReadError';
  // #endregion

  // #region Constructor
  /** Preserves the reason for deciding whether to restart, retry or stop the scan. */
  public constructor(
    public readonly reason:
      'invalid-cursor' | 'invalid-query' | 'organization-not-found' | 'unavailable' | 'cancelled',
  ) {
    super(`Cannot read the billing usage snapshot (${reason}).`);
  }
  // #endregion
}
