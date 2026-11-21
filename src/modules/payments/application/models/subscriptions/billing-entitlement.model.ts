/** The complete effective plan committed for quota admission. */
export interface BillingEntitlement {
  // #region Properties
  /** Effective paid or baseline plan. */
  readonly plan: 'free' | 'team';

  /** Enforceable number of included seats. */
  readonly seatLimit: number;

  /** Enforceable limit for ready attachment bytes. */
  readonly storageByteLimit: number;

  /** Monotonic committed version. Zero is the legacy Free baseline. */
  readonly version: number;
  // #endregion
}
