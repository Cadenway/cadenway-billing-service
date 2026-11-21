import type { UsageRebuildState } from '../../../../models/rebuild/usage-rebuild-state.model.js';

/** Reads the tenant's active and candidate generations in one snapshot. */
export interface UsageRebuildStateReader {
  // #region Methods
  /** Returns validated pointers and broker checkpoints for the selected organization. */
  read(organizationId: string): Promise<UsageRebuildState>;
  // #endregion
}
