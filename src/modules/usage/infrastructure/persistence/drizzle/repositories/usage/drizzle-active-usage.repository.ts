import type { DatabaseSchema, TenantTransactionRunner } from '@cadenway/nest-common/database';
import { and, eq } from 'drizzle-orm';

import type { UsageAdvisoryObservation } from '../../../../../application/models/rebuild/usage-advisory-observation.model.js';
import type { UsageRebuildBrokerProgress } from '../../../../../application/models/rebuild/usage-rebuild-broker-progress.model.js';
import type { ActiveUsageReader } from '../../../../../application/ports/outbound/persistence/usage/active-usage-reader.port.js';
import type { UsageTotals } from '../../../../../domain/value-objects/observations/usage-totals.value-object.js';
import {
  usageAdvisoryEvidence,
  usageRebuildCheckpoint,
} from '../../mappers/rebuild/usage-rebuild-checkpoint.mapper.js';
import { usageGenerations, usageOrganizations } from '../../schemas/usage/usage.schema.js';

/** Reads the ready active usage generation within the signed tenant's transaction. */
export class DrizzleActiveUsageReader implements ActiveUsageReader {
  // #region Constructor
  /** Binds the reader to the service kit's tenant transaction runner. */
  public constructor(private readonly runner: TenantTransactionRunner<DatabaseSchema>) {}
  // #endregion

  // #region Methods
  /** Returns ready totals when the optional continuity check accepts the same generation. */
  public read(
    organizationId: string,
    confirm?: (
      checkpoint: UsageRebuildBrokerProgress,
      advisory: UsageAdvisoryObservation | null,
    ) => boolean,
  ): Promise<UsageTotals | null> {
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
            streamCheckpoint: usageGenerations.streamCheckpoint,
            certifiedAdvisory: usageGenerations.certifiedAdvisory,
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

        const row = rows[0];
        if (row === undefined) return null;
        const { streamCheckpoint, certifiedAdvisory, ...totals } = row;
        if (confirm !== undefined) {
          const checkpoint = usageRebuildCheckpoint.safeParse(streamCheckpoint);
          const frontier = checkpoint.data?.verified ?? checkpoint.data?.promotion;
          if (
            frontier === undefined ||
            !confirm(frontier, usageAdvisoryEvidence.safeParse(certifiedAdvisory).data ?? null)
          )
            return null;
        }
        return totals;
      },
      { readOnly: true },
    );
  }
  // #endregion
}
