abstract class DomainError extends Error {}

/** A source observation version is outside the range Billing can order exactly. */
export class UsageObservationError extends DomainError {
  // #region Properties
  /** Identifies an invalid source observation in error reporting. */
  public override readonly name = 'UsageObservationError';
  // #endregion

  // #region Constructor
  /** Refuses an observation version that is not a positive safe integer. */
  public constructor() {
    super('Usage observation version must be a positive safe integer.');
  }
  // #endregion
}
