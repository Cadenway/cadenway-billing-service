import type { RecordedUsageObservation } from '../../../../../domain/value-objects/observations/recorded-usage-observation.value-object.js';
import type { UsageSnapshotPage } from '../../../../models/usage-snapshot/usage-snapshot-page.model.js';
import type { UsageSnapshotQuery } from '../../../../models/usage-snapshot/usage-snapshot-query.model.js';

/** Reads the authoritative roster and tenant usage exports outside Billing transactions. */
export interface UsageSnapshotSource {
  // #region Methods
  /** Lists organization identifiers under the Billing system identity. */
  listOrganizations(query: UsageSnapshotQuery): Promise<UsageSnapshotPage<string>>;

  /** Reads memberships and retained removals from the specified source organization. */
  listMemberships(
    organizationId: string,
    query: UsageSnapshotQuery,
  ): Promise<UsageSnapshotPage<RecordedUsageObservation>>;

  /** Reads verified attachment sizes and retained deletions from the specified organization. */
  listAttachments(
    organizationId: string,
    query: UsageSnapshotQuery,
  ): Promise<UsageSnapshotPage<RecordedUsageObservation>>;
  // #endregion
}
