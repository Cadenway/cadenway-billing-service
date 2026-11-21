import { applyRecordedUsageObservation } from '../../../../../domain/policies/observations/apply-recorded-usage-observation.policy.js';
import type { UsageRebuildUnitOfWork } from '../../../../ports/outbound/transactions/rebuild/usage-rebuild-unit-of-work.port.js';
import type { ApplyUsageRebuildPageInput } from './apply-usage-rebuild-page.input.js';
import type { ApplyUsageRebuildPageOutput } from './apply-usage-rebuild-page.output.js';

/** Reconciles one bounded authoritative page without emitting quota notifications. */
export class ApplyUsageRebuildPage {
  // #region Constructor
  /** Binds the tenant-scoped generation transaction. */
  public constructor(private readonly unitOfWork: UsageRebuildUnitOfWork) {}
  // #endregion

  // #region Methods
  /** Compares the fetched cursor under the organization lock and commits the page atomically. */
  public execute(input: ApplyUsageRebuildPageInput): Promise<ApplyUsageRebuildPageOutput> {
    if (
      input.items.length > 100 ||
      (input.nextCursor !== null &&
        (input.nextCursor.length === 0 ||
          input.nextCursor.length > 1024 ||
          input.nextCursor === input.expectedCursor))
    ) {
      return Promise.reject(new Error('The usage rebuild page is invalid.'));
    }
    const ids = new Set<string>();
    for (const item of input.items) {
      if (item.source !== input.source || ids.has(item.sourceId.toLowerCase())) {
        return Promise.reject(
          new Error('The usage rebuild page contains an invalid source or duplicate ID.'),
        );
      }
      ids.add(item.sourceId.toLowerCase());
    }
    return this.unitOfWork.run(input.organizationId, async (transaction) => {
      await transaction.lockOrganization();
      const candidate = await transaction.candidate();
      if (candidate?.id !== input.generationId) return 'stale';
      const checkpoint = candidate[input.source];
      if (checkpoint.complete || checkpoint.cursor !== input.expectedCursor) return 'stale';
      let totals = candidate.totals;
      for (const item of input.items) {
        const previous = await transaction.loadObservation(
          candidate.id,
          item.source,
          item.sourceId,
        );
        const result = applyRecordedUsageObservation(previous, item, totals);
        if (result !== null) {
          await transaction.saveObservation(candidate.id, result.observation);
          totals = result.totals;
        }
      }
      await transaction.savePage(candidate.id, input.source, totals, input.nextCursor);
      return 'applied';
    });
  }
  // #endregion
}
