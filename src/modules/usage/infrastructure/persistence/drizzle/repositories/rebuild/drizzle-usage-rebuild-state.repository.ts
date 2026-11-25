import type { DatabaseSchema, TenantTransactionRunner } from '@cadenway/nest-common/database';
import { and, eq } from 'drizzle-orm';

import type { ActiveUsageGeneration } from '../../../../../application/models/rebuild/active-usage-generation.model.js';
import type { UsageRebuildCandidate } from '../../../../../application/models/rebuild/usage-rebuild-candidate.model.js';
import type { UsageRebuildState } from '../../../../../application/models/rebuild/usage-rebuild-state.model.js';
import type { UsageRebuildStateReader } from '../../../../../application/ports/outbound/persistence/rebuild/usage-rebuild-state-reader.port.js';
import { usageRebuildCheckpoint } from '../../mappers/rebuild/usage-rebuild-checkpoint.mapper.js';
import { usageGenerations, usageOrganizations } from '../../schemas/usage/usage.schema.js';

/** Reads both generation pointers and their checkpoints in one tenant snapshot. */
export class DrizzleUsageRebuildStateReader implements UsageRebuildStateReader {
  // #region Constructor
  /** Binds the read to the kit's tenant runner. */
  public constructor(private readonly runner: TenantTransactionRunner<DatabaseSchema>) {}
  // #endregion

  // #region Methods
  /** Returns only the ready active and building candidate for this organization. */
  public read(organizationId: string): Promise<UsageRebuildState> {
    return this.runner.run(
      async (scope) => {
        if (scope.kind !== 'tenant' || scope.organizationId !== organizationId) {
          throw new Error('Usage rebuild state organization does not match its tenant scope.');
        }
        const roots = await scope.db
          .select()
          .from(usageOrganizations)
          .where(eq(usageOrganizations.organizationId, organizationId))
          .limit(1);
        const root = roots[0];
        if (root === undefined) return { active: null, candidate: null };

        const getGeneration = async (id: string) => {
          const rows = await scope.db
            .select()
            .from(usageGenerations)
            .where(
              and(eq(usageGenerations.organizationId, organizationId), eq(usageGenerations.id, id)),
            )
            .limit(1);
          const row = rows[0];
          if (row?.checkpointVersion !== 1) throw new Error('Usage generation is unavailable.');
          const checkpoint = usageRebuildCheckpoint.safeParse(row.streamCheckpoint);
          if (!checkpoint.success) throw new Error('Usage rebuild checkpoint is invalid.');
          return { row, checkpoint: checkpoint.data };
        };

        let active: ActiveUsageGeneration | null = null;
        if (root.activeGenerationId !== null) {
          const { row, checkpoint } = await getGeneration(root.activeGenerationId);
          if (row.status === 'ready' && checkpoint.promotion !== undefined) {
            active = {
              id: row.id,
              version: row.version,
              brokerAtPromotion: checkpoint.verified ?? checkpoint.promotion,
              advisory: checkpoint.advisory ?? null,
            };
          } else if (row.status !== 'invalid') {
            throw new Error('Usage active generation has an invalid state.');
          }
        }

        let candidate: UsageRebuildCandidate | null = null;
        if (root.candidateGenerationId !== null) {
          const { row, checkpoint } = await getGeneration(root.candidateGenerationId);
          if (row.status !== 'building' || checkpoint.promotion !== undefined) {
            throw new Error('Usage candidate generation has an invalid state.');
          }
          candidate = {
            id: row.id,
            version: row.version,
            totals: { seats: row.seats, guests: row.guests, storageBytes: row.storageBytes },
            membership: { cursor: row.membershipCursor, complete: row.membershipScanComplete },
            attachment: { cursor: row.attachmentCursor, complete: row.attachmentScanComplete },
            brokerAtStart: checkpoint.start,
            advisory: checkpoint.advisory ?? null,
          };
        }
        return { active, candidate };
      },
      { readOnly: true, isolationLevel: 'repeatable read' },
    );
  }
  // #endregion
}
