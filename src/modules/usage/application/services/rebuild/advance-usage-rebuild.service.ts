import { UsageSnapshotReadError } from '../../../domain/errors/usage-snapshot/usage-snapshot-read.error.js';
import type { ActiveUsageGeneration } from '../../models/rebuild/active-usage-generation.model.js';
import type { UsageRebuildBrokerProgress } from '../../models/rebuild/usage-rebuild-broker-progress.model.js';
import type { UsageRebuildCandidate } from '../../models/rebuild/usage-rebuild-candidate.model.js';
import type { UsageSnapshotSource } from '../../ports/outbound/http/snapshot/usage-snapshot-source.port.js';
import type { UsageBrokerProof } from '../../ports/outbound/messaging/rebuild/usage-broker-proof.port.js';
import type { UsageBrokerSampleReader } from '../../ports/outbound/messaging/rebuild/usage-broker-sample-reader.port.js';
import type { UsageRebuildStateReader } from '../../ports/outbound/persistence/rebuild/usage-rebuild-state-reader.port.js';
import type { UsageRebuildUnitOfWork } from '../../ports/outbound/transactions/rebuild/usage-rebuild-unit-of-work.port.js';
import type { ApplyUsageRebuildPage } from '../../use-cases/commands/rebuild/apply-usage-rebuild-page/apply-usage-rebuild-page.use-case.js';
import type { InvalidateActiveUsage } from '../../use-cases/commands/rebuild/invalidate-active-usage/invalidate-active-usage.use-case.js';
import type { PromoteUsageRebuild } from '../../use-cases/commands/rebuild/promote-usage-rebuild/promote-usage-rebuild.use-case.js';
import type { StartUsageRebuild } from '../../use-cases/commands/rebuild/start-usage-rebuild/start-usage-rebuild.use-case.js';

/** Performs one bounded source or promotion step for a single organization's usage rebuild. */
export class AdvanceUsageRebuild {
  // #region Constructor
  /** Binds existing commands and independently sampled sources. */
  public constructor(
    private readonly state: UsageRebuildStateReader,
    private readonly broker: UsageBrokerSampleReader,
    private readonly proof: UsageBrokerProof,
    private readonly source: UsageSnapshotSource,
    private readonly start: StartUsageRebuild,
    private readonly apply: ApplyUsageRebuildPage,
    private readonly promote: PromoteUsageRebuild,
    private readonly invalidateActive: InvalidateActiveUsage,
    private readonly unitOfWork: UsageRebuildUnitOfWork,
  ) {}
  // #endregion

  // #region Methods
  /** Reads at most one source page, or checks one generation lifecycle transition. */
  public async advance(
    organizationId: string,
    signal?: AbortSignal,
  ): Promise<'healthy' | 'started' | 'applied' | 'waiting' | 'stale' | 'invalidated' | 'promoted'> {
    const current = await this.state.read(organizationId);
    const observation = await this.broker.read(signal);
    if (observation === null) return 'waiting';

    if (!observation.advisoriesClear) {
      return this.invalidateUncertain(organizationId, current.active, current.candidate);
    }

    if (current.active !== null) {
      const active = current.active;
      const health = this.proof.assess(
        active.brokerAtPromotion,
        observation.progress,
        observation.advisoriesClear,
      );
      if (health === 'lost') {
        return this.invalidateActive.execute({
          organizationId,
          generationId: active.id,
          expectedVersion: active.version,
        });
      }
      if (health === 'covered' && !sameProgress(active.brokerAtPromotion, observation.progress)) {
        const updated = await this.unitOfWork.run(organizationId, async (transaction) => {
          await transaction.lockOrganization();
          return transaction.checkpointActive(active.id, active.version, observation.progress);
        });
        if (!updated) return 'stale';
      }
      if (current.candidate === null) return health === 'covered' ? 'healthy' : 'waiting';
    }

    if (current.candidate === null) {
      if (!this.proof.validStart(observation.progress, observation.advisoriesClear))
        return 'waiting';
      const started = await this.start.execute({
        organizationId,
        brokerAtStart: observation.progress,
        advisoriesClear: observation.advisoriesClear,
      });
      return started.created ? 'started' : 'stale';
    }

    const candidate = current.candidate;
    const continuity = this.proof.assess(
      candidate.brokerAtStart,
      observation.progress,
      observation.advisoriesClear,
    );
    if (continuity === 'lost') return this.abandon(organizationId, candidate);
    if (candidate.membership.complete && candidate.attachment.complete) {
      const result = await this.promote.execute({
        organizationId,
        generationId: candidate.id,
        expectedCandidateVersion: candidate.version,
        brokerAtPromotion: observation.progress,
        advisoriesClear: observation.advisoriesClear,
      });
      return result === 'pending' ? 'waiting' : result;
    }

    const source = candidate.membership.complete ? 'attachment' : 'membership';
    const expectedCursor = candidate[source].cursor;
    try {
      const query = {
        cursor: expectedCursor,
        limit: 100,
        ...(signal === undefined ? {} : { signal }),
      };
      const page =
        source === 'membership'
          ? await this.source.listMemberships(organizationId, query)
          : await this.source.listAttachments(organizationId, query);
      const result = await this.apply.execute({
        organizationId,
        generationId: candidate.id,
        source,
        expectedCursor,
        nextCursor: page.nextCursor,
        items: page.items,
      });
      return result === 'applied' ? 'applied' : 'stale';
    } catch (error: unknown) {
      if (error instanceof UsageSnapshotReadError && error.reason === 'invalid-cursor') {
        return this.abandon(organizationId, candidate);
      }
      throw error;
    }
  }

  private abandon(
    organizationId: string,
    observed: UsageRebuildCandidate,
  ): Promise<'invalidated' | 'stale'> {
    return this.unitOfWork.run(organizationId, async (transaction) => {
      await transaction.lockOrganization();
      const current = await transaction.candidate();
      if (current?.id !== observed.id || current.version !== observed.version) return 'stale';
      await transaction.abandon(current.id);
      return 'invalidated';
    });
  }

  private invalidateUncertain(
    organizationId: string,
    active: ActiveUsageGeneration | null,
    candidate: UsageRebuildCandidate | null,
  ): Promise<'waiting' | 'stale' | 'invalidated'> {
    return this.unitOfWork.run(organizationId, async (transaction) => {
      await transaction.lockOrganization();
      const selectedCandidate = await transaction.candidate();
      const invalidateCandidate = candidate !== null && selectedCandidate?.id === candidate.id;
      if (active !== null) {
        // The generation crossed the unconfirmed interval even if an event advanced its version.
        const invalidated = await transaction.invalidateActive(active.id, null);
        if (!invalidated) {
          if (invalidateCandidate) await transaction.abandon(selectedCandidate.id);
          return 'stale';
        }
      }
      if (invalidateCandidate) {
        await transaction.abandon(selectedCandidate.id);
      }
      return active !== null || invalidateCandidate ? 'invalidated' : 'waiting';
    });
  }
  // #endregion
}

function sameProgress(
  left: UsageRebuildBrokerProgress,
  right: UsageRebuildBrokerProgress,
): boolean {
  return (
    left.stream === right.stream &&
    left.createdAt === right.createdAt &&
    left.firstSequence === right.firstSequence &&
    left.lastSequence === right.lastSequence &&
    left.retainedGapCount === right.retainedGapCount &&
    left.consumers.length === right.consumers.length &&
    left.consumers.every((consumer) =>
      right.consumers.some(
        (other) =>
          consumer.handler === other.handler &&
          consumer.createdAt === other.createdAt &&
          consumer.deliveredSequence === other.deliveredSequence &&
          consumer.ackFloorSequence === other.ackFloorSequence &&
          consumer.pending === other.pending &&
          consumer.ackPending === other.ackPending,
      ),
    )
  );
}
