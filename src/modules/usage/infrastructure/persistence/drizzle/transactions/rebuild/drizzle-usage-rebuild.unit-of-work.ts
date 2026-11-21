import type { DatabaseSchema, TenantTransactionRunner } from '@cadenway/nest-common/database';
import { and, eq, sql } from 'drizzle-orm';

import type { UsageRebuildBrokerProgress } from '../../../../../application/models/rebuild/usage-rebuild-broker-progress.model.js';
import type { UsageRebuildCandidate } from '../../../../../application/models/rebuild/usage-rebuild-candidate.model.js';
import type { UsageRebuildTransaction } from '../../../../../application/ports/outbound/transactions/rebuild/usage-rebuild-transaction.port.js';
import type { UsageRebuildUnitOfWork } from '../../../../../application/ports/outbound/transactions/rebuild/usage-rebuild-unit-of-work.port.js';
import type { RecordedUsageObservation } from '../../../../../domain/value-objects/observations/recorded-usage-observation.value-object.js';
import { usageRebuildCheckpoint } from '../../mappers/rebuild/usage-rebuild-checkpoint.mapper.js';
import {
  usageGenerations,
  usageObservations,
  usageOrganizations,
} from '../../schemas/usage/usage.schema.js';

/** Persists one organization's usage rebuild in its tenant transaction. */
export class DrizzleUsageRebuildUnitOfWork implements UsageRebuildUnitOfWork {
  // #region Constructor
  /** Binds all rebuild writes to the kit's tenant runner. */
  public constructor(private readonly runner: TenantTransactionRunner<DatabaseSchema>) {}
  // #endregion

  // #region Methods
  /** Locks the organization before allowing access to its current candidate. */
  public run<T>(
    organizationId: string,
    work: (transaction: UsageRebuildTransaction) => Promise<T>,
  ): Promise<T> {
    return this.runner.run(async (scope) => {
      if (scope.kind !== 'tenant' || scope.organizationId !== organizationId) {
        throw new Error('Usage rebuild organization does not match its tenant scope.');
      }

      let locked = false;
      let selectedId: string | null = null;
      let activeId: string | null = null;
      const requireLock = (): void => {
        if (!locked) throw new Error('The usage organization must be locked first.');
      };
      const requireCandidate = (generationId: string): void => {
        requireLock();
        if (generationId !== selectedId) throw new Error('Usage candidate is not current.');
      };
      const candidate = async (): Promise<UsageRebuildCandidate | null> => {
        requireLock();
        if (selectedId === null) return null;
        const rows = await scope.db
          .select()
          .from(usageGenerations)
          .where(
            and(
              eq(usageGenerations.organizationId, organizationId),
              eq(usageGenerations.id, selectedId),
              eq(usageGenerations.status, 'building'),
            ),
          )
          .limit(1);
        const row = rows[0];
        if (row?.checkpointVersion !== 1) {
          throw new Error('Usage rebuild candidate is unavailable.');
        }
        const parsed = usageRebuildCheckpoint.safeParse(row.streamCheckpoint);
        if (!parsed.success || parsed.data.promotion !== undefined) {
          throw new Error('Usage rebuild checkpoint is invalid.');
        }
        return {
          id: row.id,
          version: row.version,
          totals: { seats: row.seats, guests: row.guests, storageBytes: row.storageBytes },
          membership: { cursor: row.membershipCursor, complete: row.membershipScanComplete },
          attachment: { cursor: row.attachmentCursor, complete: row.attachmentScanComplete },
          brokerAtStart: parsed.data.start,
        };
      };
      return work({
        lockOrganization: async () => {
          if (locked) throw new Error('The usage organization is already locked.');
          await scope.db
            .insert(usageOrganizations)
            .values({ organizationId })
            .onConflictDoNothing();
          const rows = await scope.db
            .select()
            .from(usageOrganizations)
            .where(eq(usageOrganizations.organizationId, organizationId))
            .for('update');
          const row = rows[0];
          if (row === undefined) throw new Error('Usage organization could not be locked.');
          selectedId = row.candidateGenerationId;
          activeId = row.activeGenerationId;
          locked = true;
        },
        candidate,
        startCandidate: async (start: UsageRebuildBrokerProgress) => {
          requireLock();
          if (selectedId !== null) throw new Error('A usage candidate already exists.');
          const startCheckpoint = usageRebuildCheckpoint.parse({ version: 1, start });
          const created = await scope.db
            .insert(usageGenerations)
            .values({
              organizationId,
              streamCheckpoint: startCheckpoint,
            })
            .returning({ id: usageGenerations.id });
          const row = created[0];
          if (row === undefined) throw new Error('Usage candidate could not be created.');
          const updated = await scope.db
            .update(usageOrganizations)
            .set({
              candidateGenerationId: row.id,
              version: sql`${usageOrganizations.version} + 1`,
              updatedAt: sql`now()`,
            })
            .where(
              and(
                eq(usageOrganizations.organizationId, organizationId),
                sql`${usageOrganizations.candidateGenerationId} is null`,
              ),
            )
            .returning({ id: usageOrganizations.organizationId });
          if (updated.length !== 1) throw new Error('Usage candidate could not be selected.');
          selectedId = row.id;
          return row.id;
        },
        loadObservation: async (generationId, source, sourceId) => {
          requireCandidate(generationId);
          const rows = await scope.db
            .select()
            .from(usageObservations)
            .where(
              and(
                eq(usageObservations.organizationId, organizationId),
                eq(usageObservations.generationId, generationId),
                eq(usageObservations.source, source),
                eq(usageObservations.sourceId, sourceId),
              ),
            )
            .limit(1);
          const row = rows[0];
          if (row === undefined) return null;
          if (row.state === 'absent')
            return {
              source,
              sourceId,
              observation: { state: 'absent', version: row.sourceVersion },
            };
          if (row.state === 'present' && source === 'attachment' && row.attachmentBytes !== null) {
            return {
              source,
              sourceId,
              observation: {
                state: 'present',
                version: row.sourceVersion,
                value: row.attachmentBytes,
              },
            };
          }
          if (
            row.state === 'present' &&
            source === 'membership' &&
            (row.membershipRole === 'owner' ||
              row.membershipRole === 'admin' ||
              row.membershipRole === 'member' ||
              row.membershipRole === 'guest')
          ) {
            return {
              source,
              sourceId,
              observation: {
                state: 'present',
                version: row.sourceVersion,
                value: row.membershipRole,
              },
            };
          }
          throw new Error('Stored usage observation has an invalid value.');
        },
        saveObservation: async (generationId: string, item: RecordedUsageObservation) => {
          requireCandidate(generationId);
          const membershipRole =
            item.source === 'membership' && item.observation.state === 'present'
              ? item.observation.value
              : null;
          const attachmentBytes =
            item.source === 'attachment' && item.observation.state === 'present'
              ? item.observation.value
              : null;
          const values = {
            organizationId,
            generationId,
            source: item.source,
            sourceId: item.sourceId,
            sourceVersion: item.observation.version,
            state: item.observation.state,
            membershipRole,
            attachmentBytes,
          };
          await scope.db
            .insert(usageObservations)
            .values(values)
            .onConflictDoUpdate({
              target: [
                usageObservations.organizationId,
                usageObservations.generationId,
                usageObservations.source,
                usageObservations.sourceId,
              ],
              set: {
                sourceVersion: values.sourceVersion,
                state: values.state,
                membershipRole,
                attachmentBytes,
                updatedAt: sql`now()`,
              },
            });
        },
        savePage: async (generationId, source, totals, nextCursor) => {
          requireCandidate(generationId);
          const fields =
            source === 'membership'
              ? { membershipCursor: nextCursor, membershipScanComplete: nextCursor === null }
              : { attachmentCursor: nextCursor, attachmentScanComplete: nextCursor === null };
          const updated = await scope.db
            .update(usageGenerations)
            .set({
              ...totals,
              ...fields,
              version: sql`${usageGenerations.version} + 1`,
              updatedAt: sql`now()`,
            })
            .where(
              and(
                eq(usageGenerations.organizationId, organizationId),
                eq(usageGenerations.id, generationId),
                eq(usageGenerations.status, 'building'),
              ),
            )
            .returning({ id: usageGenerations.id });
          if (updated.length !== 1) throw new Error('Usage rebuild page could not be saved.');
        },
        promote: async (generationId, promotion) => {
          requireCandidate(generationId);
          const current = await candidate();
          if (current === null || !current.membership.complete || !current.attachment.complete) {
            throw new Error('Usage rebuild is not ready for promotion.');
          }
          const completeCheckpoint = usageRebuildCheckpoint.parse({
            version: 1,
            start: current.brokerAtStart,
            promotion,
          });
          const updated = await scope.db
            .update(usageGenerations)
            .set({
              status: 'ready',
              streamCheckpoint: completeCheckpoint,
              version: sql`${usageGenerations.version} + 1`,
              updatedAt: sql`now()`,
            })
            .where(
              and(
                eq(usageGenerations.organizationId, organizationId),
                eq(usageGenerations.id, generationId),
                eq(usageGenerations.status, 'building'),
              ),
            )
            .returning({ id: usageGenerations.id });
          if (updated.length !== 1) throw new Error('Usage candidate could not be promoted.');
          const root = await scope.db
            .update(usageOrganizations)
            .set({
              activeGenerationId: generationId,
              candidateGenerationId: null,
              version: sql`${usageOrganizations.version} + 1`,
              updatedAt: sql`now()`,
            })
            .where(
              and(
                eq(usageOrganizations.organizationId, organizationId),
                eq(usageOrganizations.candidateGenerationId, generationId),
              ),
            )
            .returning({ id: usageOrganizations.organizationId });
          if (root.length !== 1) throw new Error('Usage candidate pointer changed.');
          selectedId = null;
          activeId = generationId;
        },
        invalidateActive: async (generationId, version) => {
          requireLock();
          if (activeId !== generationId) return false;
          const invalidated = await scope.db
            .update(usageGenerations)
            .set({
              status: 'invalid',
              version: sql`${usageGenerations.version} + 1`,
              updatedAt: sql`now()`,
            })
            .where(
              and(
                eq(usageGenerations.organizationId, organizationId),
                eq(usageGenerations.id, generationId),
                eq(usageGenerations.status, 'ready'),
                eq(usageGenerations.version, version),
              ),
            )
            .returning({ id: usageGenerations.id });
          return invalidated.length === 1;
        },
        abandon: async (generationId) => {
          requireCandidate(generationId);
          const updated = await scope.db
            .update(usageGenerations)
            .set({
              status: 'invalid',
              version: sql`${usageGenerations.version} + 1`,
              updatedAt: sql`now()`,
            })
            .where(
              and(
                eq(usageGenerations.organizationId, organizationId),
                eq(usageGenerations.id, generationId),
                eq(usageGenerations.status, 'building'),
              ),
            )
            .returning({ id: usageGenerations.id });
          if (updated.length !== 1) throw new Error('Usage candidate could not be invalidated.');
          const root = await scope.db
            .update(usageOrganizations)
            .set({
              candidateGenerationId: null,
              version: sql`${usageOrganizations.version} + 1`,
              updatedAt: sql`now()`,
            })
            .where(
              and(
                eq(usageOrganizations.organizationId, organizationId),
                eq(usageOrganizations.candidateGenerationId, generationId),
              ),
            )
            .returning({ id: usageOrganizations.organizationId });
          if (root.length !== 1) throw new Error('Usage candidate pointer changed.');
          selectedId = null;
        },
      });
    });
  }
  // #endregion
}
