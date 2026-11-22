/** Authorization for the first dispatch, bound to its committed reservation version. */
export interface FirstCheckoutDispatch {
  // #region Properties
  /** Distinguishes the first authorization from a retry. */
  readonly status: 'first-dispatch';

  /** Reservation version directly after recording this first dispatch. */
  readonly version: number;
  // #endregion
}
