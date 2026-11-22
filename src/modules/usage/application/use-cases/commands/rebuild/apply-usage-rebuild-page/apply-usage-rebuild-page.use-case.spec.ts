import { describe, expect, it, vi } from 'vitest';

import type { UsageRebuildBrokerProgress } from '../../../../models/rebuild/usage-rebuild-broker-progress.model.js';
import type { UsageRebuildCandidate } from '../../../../models/rebuild/usage-rebuild-candidate.model.js';
import type { UsageRebuildTransaction } from '../../../../ports/outbound/transactions/rebuild/usage-rebuild-transaction.port.js';
import type { UsageRebuildUnitOfWork } from '../../../../ports/outbound/transactions/rebuild/usage-rebuild-unit-of-work.port.js';
import type { ApplyUsageRebuildPageInput } from './apply-usage-rebuild-page.input.js';
import { ApplyUsageRebuildPage } from './apply-usage-rebuild-page.use-case.js';

const broker: UsageRebuildBrokerProgress = {
  stream: 'EVENTS',
  createdAt: '2026-01-01T00:00:00Z',
  firstSequence: 1,
  lastSequence: 1,
  retainedGapCount: 0,
  consumers: [],
};
const candidate: UsageRebuildCandidate = {
  id: 'generation',
  version: 3,
  totals: { seats: 0, guests: 0, storageBytes: 0 },
  membership: { cursor: null, complete: false },
  attachment: { cursor: null, complete: false },
  brokerAtStart: broker,
};
const member = {
  source: 'membership',
  sourceId: 'member',
  observation: { state: 'present', version: 1, value: 'member' },
} as const;
const input: ApplyUsageRebuildPageInput = {
  organizationId: 'organization',
  generationId: 'generation',
  source: 'membership',
  expectedCursor: null,
  nextCursor: 'second',
  items: [member],
};

function setup(current: UsageRebuildCandidate | null): {
  readonly command: ApplyUsageRebuildPage;
  readonly transaction: UsageRebuildTransaction;
} {
  const transaction: UsageRebuildTransaction = {
    lockOrganization: vi.fn().mockResolvedValue(undefined),
    candidate: vi.fn().mockResolvedValue(current),
    startCandidate: vi.fn().mockResolvedValue('generation'),
    loadObservations: vi.fn().mockResolvedValue([]),
    saveObservations: vi.fn().mockResolvedValue(undefined),
    savePage: vi.fn().mockResolvedValue(undefined),
    promote: vi.fn().mockResolvedValue(undefined),
    abandon: vi.fn().mockResolvedValue(undefined),
    invalidateActive: vi.fn().mockResolvedValue(true),
    checkpointActive: vi.fn().mockResolvedValue(true),
    flushThresholdIntents: vi.fn().mockResolvedValue(true),
  };
  const unit: UsageRebuildUnitOfWork = {
    async run<T>(
      _organizationId: string,
      work: (tx: UsageRebuildTransaction) => Promise<T>,
    ): Promise<T> {
      return work(transaction);
    },
  };
  return { command: new ApplyUsageRebuildPage(unit), transaction };
}

describe('ApplyUsageRebuildPage', () => {
  it('locks the organization and records the source observation and cursor together', async () => {
    const { command, transaction } = setup(candidate);
    await expect(command.execute(input)).resolves.toBe('applied');
    expect(transaction.lockOrganization).toHaveBeenCalledOnce();
    expect(transaction.loadObservations).toHaveBeenCalledExactlyOnceWith(
      'generation',
      'membership',
      [member.sourceId],
    );
    expect(transaction.saveObservations).toHaveBeenCalledExactlyOnceWith('generation', [member]);
    expect(transaction.savePage).toHaveBeenCalledWith(
      'generation',
      'membership',
      { seats: 1, guests: 0, storageBytes: 0 },
      'second',
    );
  });

  it('retains a newer terminal event when an older source page arrives', async () => {
    const { command, transaction } = setup(candidate);
    vi.mocked(transaction.loadObservations).mockResolvedValue([
      {
        ...member,
        observation: { state: 'absent', version: 2 },
      },
    ]);
    await expect(command.execute({ ...input, nextCursor: null })).resolves.toBe('applied');
    expect(transaction.saveObservations).not.toHaveBeenCalled();
    expect(transaction.savePage).toHaveBeenCalledWith(
      'generation',
      'membership',
      candidate.totals,
      null,
    );
  });

  it.each([
    { ...candidate, id: 'replacement' },
    { ...candidate, membership: { cursor: 'new-cursor', complete: false } },
    { ...candidate, membership: { cursor: null, complete: true } },
  ])('ignores a fetched page when the candidate or cursor is stale', async (changed) => {
    const { command, transaction } = setup(changed);
    await expect(command.execute(input)).resolves.toBe('stale');
    expect(transaction.loadObservations).not.toHaveBeenCalled();
    expect(transaction.saveObservations).not.toHaveBeenCalled();
    expect(transaction.savePage).not.toHaveBeenCalled();
  });

  it('records an empty terminal page without reading or writing observations', async () => {
    const { command, transaction } = setup(candidate);
    await expect(command.execute({ ...input, nextCursor: null, items: [] })).resolves.toBe(
      'applied',
    );
    expect(transaction.loadObservations).not.toHaveBeenCalled();
    expect(transaction.saveObservations).not.toHaveBeenCalled();
    expect(transaction.savePage).toHaveBeenCalledExactlyOnceWith(
      'generation',
      'membership',
      candidate.totals,
      null,
    );
  });

  it('refuses repeated cursors, duplicates and oversized pages before persistence', async () => {
    const { command, transaction } = setup(candidate);
    await expect(
      command.execute({ ...input, expectedCursor: 'same', nextCursor: 'same' }),
    ).rejects.toThrow();
    await expect(
      command.execute({ ...input, items: [member, { ...member, sourceId: 'MEMBER' }] }),
    ).rejects.toThrow();
    await expect(
      command.execute({ ...input, items: Array.from({ length: 101 }, () => member) }),
    ).rejects.toThrow();
    expect(transaction.lockOrganization).not.toHaveBeenCalled();
  });
});
