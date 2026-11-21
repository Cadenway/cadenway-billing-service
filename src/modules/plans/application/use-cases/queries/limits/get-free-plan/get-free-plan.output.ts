/** Entitlement of the Free plan before paid subscriptions are available. */
export interface GetFreePlanOutput {
  // #region Properties
  /** Stable identifier of the Free plan. */
  readonly id: 'free';

  /** Included seats for owners, administrators and members. */
  readonly seats: number;

  /** Included verified attachment storage in bytes. */
  readonly storageBytes: number;
  // #endregion
}
