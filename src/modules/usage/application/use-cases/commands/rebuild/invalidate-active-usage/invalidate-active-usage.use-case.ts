import type { UsageRebuildUnitOfWork } from '../../../../ports/outbound/transactions/rebuild/usage-rebuild-unit-of-work.port.js';
import type { InvalidateActiveUsageInput } from './invalidate-active-usage.input.js';
import type { InvalidateActiveUsageOutput } from './invalidate-active-usage.output.js';

/** Makes an active projection unavailable after confirmed broker continuity loss. */
export class InvalidateActiveUsage {
  // #region Constructor
  /** Binds the tenant-scoped transaction. */
  public constructor(private readonly unitOfWork: UsageRebuildUnitOfWork) {}
  // #endregion

  // #region Methods
  /** Invalidates only the generation and version for which the loss was observed. */
  public execute(input: InvalidateActiveUsageInput): Promise<InvalidateActiveUsageOutput> {
    return this.unitOfWork.run(input.organizationId, async (transaction) => {
      await transaction.lockOrganization();
      const invalidated = await transaction.invalidateActive(
        input.generationId,
        input.expectedVersion,
      );
      return invalidated ? 'invalidated' : 'stale';
    });
  }
  // #endregion
}
