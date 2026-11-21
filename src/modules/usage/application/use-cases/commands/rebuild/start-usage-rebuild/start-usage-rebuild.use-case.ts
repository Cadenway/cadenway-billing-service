import type { UsageBrokerProof } from '../../../../ports/outbound/messaging/rebuild/usage-broker-proof.port.js';
import type { UsageRebuildUnitOfWork } from '../../../../ports/outbound/transactions/rebuild/usage-rebuild-unit-of-work.port.js';
import type { StartUsageRebuildInput } from './start-usage-rebuild.input.js';
import type { StartUsageRebuildOutput } from './start-usage-rebuild.output.js';

/** Starts one candidate per organization, or resumes its existing candidate. */
export class StartUsageRebuild {
  // #region Constructor
  /** Binds the transaction and the pure starting-evidence verifier. */
  public constructor(
    private readonly unitOfWork: UsageRebuildUnitOfWork,
    private readonly proof: UsageBrokerProof,
  ) {}
  // #endregion

  // #region Methods
  /** Captures the validated broker baseline before the first source scan. */
  public execute(input: StartUsageRebuildInput): Promise<StartUsageRebuildOutput> {
    return this.unitOfWork.run(input.organizationId, async (transaction) => {
      await transaction.lockOrganization();
      const existing = await transaction.candidate();
      if (existing !== null) return { generationId: existing.id, created: false };
      if (!this.proof.validStart(input.brokerAtStart, input.advisoriesClear)) {
        throw new Error('The starting event stream evidence is unavailable.');
      }
      return { generationId: await transaction.startCandidate(input.brokerAtStart), created: true };
    });
  }
  // #endregion
}
