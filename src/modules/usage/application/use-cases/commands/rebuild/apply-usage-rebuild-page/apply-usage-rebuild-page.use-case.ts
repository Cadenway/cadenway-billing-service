import { applyRecordedUsageObservation } from '../../../../../domain/policies/observations/apply-recorded-usage-observation.policy.js';
import type { RecordedUsageObservation } from '../../../../../domain/value-objects/observations/recorded-usage-observation.value-object.js';
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
    const page: RecordedUsageObservation[] = [];
    for (const item of input.items) {
      const sourceId = item.sourceId.toLowerCase();
      if (item.source !== input.source || ids.has(sourceId)) {
        return Promise.reject(
          new Error('The usage rebuild page contains an invalid source or duplicate ID.'),
        );
      }
      ids.add(sourceId);
      page.push({ ...item, sourceId });
    }
    return this.unitOfWork.run(input.organizationId, async (transaction) => {
      await transaction.lockOrganization();
      const candidate = await transaction.candidate();
      if (candidate?.id !== input.generationId) return 'stale';
      const checkpoint = candidate[input.source];
      if (checkpoint.complete || checkpoint.cursor !== input.expectedCursor) return 'stale';
      const existing =
        page.length === 0
          ? []
          : await transaction.loadObservations(candidate.id, input.source, [...ids]);
      const previousById = new Map(existing.map((item) => [item.sourceId, item]));
      const accepted: RecordedUsageObservation[] = [];
      let totals = candidate.totals;
      for (const item of page) {
        const previous = previousById.get(item.sourceId) ?? null;
        const result = applyRecordedUsageObservation(previous, item, totals);
        if (result !== null) {
          accepted.push(result.observation);
          totals = result.totals;
        }
      }
      if (accepted.length > 0) await transaction.saveObservations(candidate.id, accepted);
      await transaction.savePage(candidate.id, input.source, totals, input.nextCursor);
      return 'applied';
    });
  }
  // #endregion
}
