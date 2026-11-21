import type { DatabaseSchema, TenantTransactionRunner } from '@cadenway/nest-common/database';
import { and, eq } from 'drizzle-orm';

import type { ActiveUsageReader } from '../../../../../application/ports/outbound/persistence/usage/active-usage-reader.port.js';
import type { UsageTotals } from '../../../../../domain/value-objects/observations/usage-totals.value-object.js';
import { usageGenerations, usageOrganizations } from '../../schemas/usage/usage.schema.js';

/** Reads the ready active usage generation within the signed tenant's transaction. */
export class DrizzleActiveUsageReader implements ActiveUsageReader {
  // #region Constructor
  /** Binds the reader to the service kit's tenant transaction runner. */
  public constructor(private readonly runner: TenantTransactionRunner<DatabaseSchema>) {}
  // #endregion

  // #region Methods
  /** Returns the current ready totals, or null if no ready active generation exists. */
  public read(organizationId: string): Promise<UsageTotals | null> {
    return this.runner.run(
      async (scope) => {
        if (scope.kind !== 'tenant' || scope.organizationId !== organizationId) {
          throw new Error('Usage query organization does not match its tenant scope.');
        }

        const rows = await scope.db
          .select({
            seats: usageGenerations.seats,
            guests: usageGenerations.guests,
            storageBytes: usageGenerations.storageBytes,
          })
          .from(usageOrganizations)
          .innerJoin(
            usageGenerations,
            and(
              eq(usageGenerations.organizationId, usageOrganizations.organizationId),
              eq(usageGenerations.id, usageOrganizations.activeGenerationId),
            ),
          )
          .where(
            and(
              eq(usageOrganizations.organizationId, organizationId),
              eq(usageGenerations.organizationId, organizationId),
              eq(usageGenerations.status, 'ready'),
            ),
          )
          .limit(1);

        return rows[0] ?? null;
      },
      { readOnly: true },
    );
  }
  // #endregion
}
