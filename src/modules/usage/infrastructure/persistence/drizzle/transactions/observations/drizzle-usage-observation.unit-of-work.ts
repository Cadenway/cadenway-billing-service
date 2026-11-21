import type { DatabaseSchema, TenantTransactionRunner } from '@cadenway/nest-common/database';
import { and, eq, sql } from 'drizzle-orm';

import type { LockedUsageOrganization } from '../../../../../application/models/observations/locked-usage-organization.model.js';
import type { UsageObservationGeneration } from '../../../../../application/models/observations/usage-observation-generation.model.js';
import type { UsageObservationTransaction } from '../../../../../application/ports/outbound/transactions/observations/usage-observation-transaction.port.js';
import type { UsageObservationUnitOfWork } from '../../../../../application/ports/outbound/transactions/observations/usage-observation-unit-of-work.port.js';
import type { RecordedUsageObservation } from '../../../../../domain/value-objects/observations/recorded-usage-observation.value-object.js';
import type { UsageTotals } from '../../../../../domain/value-objects/observations/usage-totals.value-object.js';
import {
  usageGenerations,
  usageObservations,
  usageOrganizations,
  usageThresholdIntents,
} from '../../schemas/usage/usage.schema.js';

/** Runs observation writes on the kit's tenant transaction. */
export class DrizzleUsageObservationUnitOfWork implements UsageObservationUnitOfWork {
  // #region Constructor
  /** Binds the tenant transaction and the current quota limits. */
  public constructor(
    private readonly runner: TenantTransactionRunner<DatabaseSchema>,
    private readonly limits: LockedUsageOrganization['limits'],
  ) {}
  // #endregion

  // #region Methods
  /** Joins the enclosing receipt transaction or starts the tenant transaction. */
  public run<T>(
    organizationId: string,
    work: (transaction: UsageObservationTransaction) => Promise<T>,
  ): Promise<T> {
    return this.runner.run(async (scope) => {
      if (scope.kind !== 'tenant' || scope.organizationId !== organizationId) {
        throw new Error('Usage transaction organization does not match its tenant scope.');
      }
      let locked = false;
      let allowedGenerations = new Set<string>();
      let activeGenerationId: string | null = null;

      const requireLock = (): void => {
        if (!locked) throw new Error('The usage organization must be locked first.');
      };
      const requireGeneration = (generationId: string): void => {
        requireLock();
        if (!allowedGenerations.has(generationId))
          throw new Error('Usage generation is not current.');
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
          const organization = rows[0];
          if (organization === undefined)
            throw new Error('Usage organization could not be locked.');

          const loadGeneration = async (
            id: string | null,
            candidate: boolean,
          ): Promise<UsageObservationGeneration | null> => {
            if (id === null) return null;
            const generations = await scope.db
              .select()
              .from(usageGenerations)
              .where(
                and(
                  eq(usageGenerations.organizationId, organizationId),
                  eq(usageGenerations.id, id),
                ),
              );
            const generation = generations[0];
            if (generation === undefined)
              throw new Error('Usage generation does not belong to the organization.');
            if (!candidate && generation.status === 'invalid') return null;
            if (generation.status !== (candidate ? 'building' : 'ready'))
              throw new Error('Usage generation has an invalid state.');
            return {
              id: generation.id,
              totals: {
                seats: generation.seats,
                guests: generation.guests,
                storageBytes: generation.storageBytes,
              },
            };
          };
          const active = await loadGeneration(organization.activeGenerationId, false);
          activeGenerationId = active?.id ?? null;
          const candidate = await loadGeneration(organization.candidateGenerationId, true);
          allowedGenerations = new Set(
            [active?.id, candidate?.id].filter((id): id is string => id !== undefined),
          );
          locked = true;
          return { active, candidate, limits: this.limits };
        },
        loadObservation: async (generationId, source, sourceId) => {
          requireGeneration(generationId);
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
            );
          const row = rows[0];
          if (row === undefined) return null;
          if (row.state === 'absent')
            return {
              source,
              sourceId,
              observation: { state: 'absent', version: row.sourceVersion },
            };
          if (row.state !== 'present')
            throw new Error('Stored usage observation has an invalid state.');
          if (source === 'attachment' && row.attachmentBytes !== null) {
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
        saveObservation: async (
          generationId: string,
          item: RecordedUsageObservation,
          totals: UsageTotals,
        ) => {
          requireGeneration(generationId);
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
          const updated = await scope.db
            .update(usageGenerations)
            .set({
              ...totals,
              version: sql`${usageGenerations.version} + 1`,
              updatedAt: sql`now()`,
            })
            .where(
              and(
                eq(usageGenerations.organizationId, organizationId),
                eq(usageGenerations.id, generationId),
              ),
            )
            .returning({ id: usageGenerations.id });
          if (updated.length !== 1) throw new Error('Usage generation could not be updated.');
        },
        recordThresholdIntent: async (generationId, fact) => {
          requireLock();
          if (generationId !== activeGenerationId) {
            throw new Error('Quota threshold intent requires the active generation.');
          }
          const column =
            fact.metric === 'seats'
              ? usageOrganizations.seatsEventVersion
              : usageOrganizations.storageEventVersion;
          const update =
            fact.metric === 'seats'
              ? { seatsEventVersion: sql`${column} + 1` }
              : { storageEventVersion: sql`${column} + 1` };
          const rows = await scope.db
            .update(usageOrganizations)
            .set({
              ...update,
              version: sql`${usageOrganizations.version} + 1`,
              updatedAt: sql`now()`,
            })
            .where(eq(usageOrganizations.organizationId, organizationId))
            .returning({ version: column });
          const row = rows[0];
          if (row === undefined) throw new Error('Usage metric version could not be advanced.');
          await scope.db
            .insert(usageThresholdIntents)
            .values({
              organizationId,
              generationId,
              metric: fact.metric,
              eventVersion: row.version,
              quotaLimit: fact.limit,
            })
            .onConflictDoUpdate({
              target: [usageThresholdIntents.organizationId, usageThresholdIntents.metric],
              set: {
                generationId,
                eventVersion: row.version,
                quotaLimit: fact.limit,
                updatedAt: sql`now()`,
              },
            });
        },
      });
    });
  }
  // #endregion
}
