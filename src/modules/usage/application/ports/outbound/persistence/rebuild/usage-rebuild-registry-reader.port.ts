/** Reads a bounded page of organizations with registered usage projections. */
export interface UsageRebuildRegistryReader {
  // #region Methods
  /** Reads ascending organization IDs, returning the next position only if more exist. */
  list(
    afterId: string | null,
    limit: number,
  ): Promise<{ readonly items: readonly string[]; readonly nextId: string | null }>;
  // #endregion
}
