/** One validated source page and its opaque continuation. */
export interface UsageSnapshotPage<T> {
  // #region Properties
  /** Source rows in ascending identifier order. */
  readonly items: readonly T[];

  /** Null marks the end of the current source scan. */
  readonly nextCursor: string | null;
  // #endregion
}
