import type { UsageBrokerProof } from '../../../../ports/outbound/messaging/rebuild/usage-broker-proof.port.js';
import type { UsageRebuildUnitOfWork } from '../../../../ports/outbound/transactions/rebuild/usage-rebuild-unit-of-work.port.js';
import type { PromoteUsageRebuildInput } from './promote-usage-rebuild.input.js';
import type { PromoteUsageRebuildOutput } from './promote-usage-rebuild.output.js';

/** Promotes only a complete candidate whose broker coverage is independently confirmed. */
export class PromoteUsageRebuild {
  // #region Constructor
  /** Binds the tenant transaction and pure broker evidence verifier. */
  public constructor(
    private readonly unitOfWork: UsageRebuildUnitOfWork,
    private readonly proof: UsageBrokerProof,
  ) {}
  // #endregion

  // #region Methods
  /** Atomically verifies the persisted candidate and switches the active pointer. */
  public execute(input: PromoteUsageRebuildInput): Promise<PromoteUsageRebuildOutput> {
    return this.unitOfWork.run(input.organizationId, async (transaction) => {
      await transaction.lockOrganization();
      const candidate = await transaction.candidate();
      if (
        candidate?.id !== input.generationId ||
        candidate.version !== input.expectedCandidateVersion
      )
        return 'stale';
      if (!candidate.membership.complete || !candidate.attachment.complete) return 'pending';
      const verdict = this.proof.assess(
        candidate.brokerAtStart,
        input.brokerAtPromotion,
        input.advisoriesClear,
      );
      if (verdict === 'lost') {
        await transaction.abandon(candidate.id);
        return 'invalidated';
      }
      if (verdict !== 'covered') return 'pending';
      await transaction.promote(candidate.id, input.brokerAtPromotion);
      return 'promoted';
    });
  }
  // #endregion
}
