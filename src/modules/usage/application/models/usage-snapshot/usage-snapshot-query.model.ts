/** Parameters for a single page of a Billing source export. */
export interface UsageSnapshotQuery {
  // #region Properties
  /** Opaque continuation from the same source and organization, or null on the first page. */
  readonly cursor: string | null;

  /** Limits the number of source rows returned. */
  readonly limit?: number;

  /** Allows a caller to abandon the read and its response body. */
  readonly signal?: AbortSignal;
  // #endregion
}
