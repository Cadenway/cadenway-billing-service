import type { DatabaseSchema, SystemTransactionRunner } from '@cadenway/nest-common/database';
import { asc, gt, gte } from 'drizzle-orm';

import type { UsageRebuildRegistryReader } from '../../../../../application/ports/outbound/persistence/rebuild/usage-rebuild-registry-reader.port.js';
import { usageOrganizations } from '../../schemas/usage/usage.schema.js';

const firstUuid = '00000000-0000-0000-0000-000000000000';

/** Reads organization IDs from the Billing-owned rebuild registry. */
export class DrizzleUsageRebuildRegistryReader implements UsageRebuildRegistryReader {
  // #region Constructor
  /** Binds cross-tenant registry enumeration to the system runner. */
  public constructor(private readonly runner: SystemTransactionRunner<DatabaseSchema>) {}
  // #endregion

  // #region Methods
  /** Reads an ascending keyset page with one row of lookahead. */
  public list(
    afterId: string | null,
    limit: number,
  ): Promise<{ readonly items: readonly string[]; readonly nextId: string | null }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      return Promise.reject(new Error('Usage rebuild registry page size must be 1 to 50.'));
    }
    return this.runner.run(
      async (scope) => {
        if (scope.kind !== 'system' || scope.organizationId !== null) {
          throw new Error('Usage rebuild registry requires system scope.');
        }
        const boundary =
          afterId === null
            ? gte(usageOrganizations.organizationId, firstUuid)
            : gt(usageOrganizations.organizationId, afterId);
        const rows = await scope.db
          .select({ id: usageOrganizations.organizationId })
          .from(usageOrganizations)
          .where(boundary)
          .orderBy(asc(usageOrganizations.organizationId))
          .limit(limit + 1);
        const items = rows.slice(0, limit).map(({ id }) => id);
        return { items, nextId: rows.length > limit ? (items.at(-1) ?? null) : null };
      },
      { readOnly: true },
    );
  }
  // #endregion
}
