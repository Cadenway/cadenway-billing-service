/** Measured usage for one organization and projection generation. */
export interface UsageTotals {
  // #region Properties
  /** Active members included in the billed seat count. */
  readonly seats: number;

  /** Active guests measured separately from billed seats. */
  readonly guests: number;

  /** Verified bytes of ready attachments. */
  readonly storageBytes: number;
  // #endregion
}
