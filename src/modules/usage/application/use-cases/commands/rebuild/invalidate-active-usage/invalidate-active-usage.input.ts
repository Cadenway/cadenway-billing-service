/** Identity of the generation whose broker continuity was confirmed lost. */
export interface InvalidateActiveUsageInput {
  // #region Properties
  /** Signed organization. */
  readonly organizationId: string;

  /** Observed active generation. */
  readonly generationId: string;

  /** Version sampled before broker continuity was checked. */
  readonly expectedVersion: number;
  // #endregion
}
