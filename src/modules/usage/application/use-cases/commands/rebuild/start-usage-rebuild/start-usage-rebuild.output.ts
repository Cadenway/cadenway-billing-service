/** Identity of the existing or newly created candidate. */
export interface StartUsageRebuildOutput {
  // #region Properties
  /** Building generation identity. */
  readonly generationId: string;

  /** Whether this transaction created the generation. */
  readonly created: boolean;
  // #endregion
}
