import { describe, expect, it, vi } from 'vitest';

import type { LockedUsageOrganization } from '../../../../models/observations/locked-usage-organization.model.js';
import type { UsageObservationTransaction } from '../../../../ports/outbound/transactions/observations/usage-observation-transaction.port.js';
import type { UsageObservationUnitOfWork } from '../../../../ports/outbound/transactions/observations/usage-observation-unit-of-work.port.js';
import type { RecordUsageObservationInput } from './record-usage-observation.input.js';
import { RecordUsageObservation } from './record-usage-observation.use-case.js';

const totals = { seats: 3, guests: 0, storageBytes: 0 };
const memberInput: RecordUsageObservationInput = {
  organizationId: 'org-1',
  observation: {
    source: 'membership',
    sourceId: 'member-1',
    observation: { state: 'present', version: 1, value: 'member' },
  },
};

function setup(organization: LockedUsageOrganization): {
  readonly command: RecordUsageObservation;
  readonly transaction: UsageObservationTransaction;
  readonly run: ReturnType<typeof vi.fn<(organizationId: string) => void>>;
} {
  const transaction: UsageObservationTransaction = {
    lockOrganization: vi.fn().mockResolvedValue(organization),
    loadObservation: vi.fn().mockResolvedValue(null),
    saveObservation: vi.fn().mockResolvedValue(undefined),
    recordThresholdIntent: vi.fn().mockResolvedValue(undefined),
  };
  const run = vi.fn<(organizationId: string) => void>();
  const unitOfWork: UsageObservationUnitOfWork = {
    async run<T>(
      organizationId: string,
      work: (tx: UsageObservationTransaction) => Promise<T>,
    ): Promise<T> {
      run(organizationId);
      return work(transaction);
    },
  };
  return { command: new RecordUsageObservation(unitOfWork), transaction, run };
}

describe('RecordUsageObservation', () => {
  it('records both generations and retains the active 80 percent crossing once', async () => {
    const { command, transaction, run } = setup({
      active: { id: 'active', totals },
      candidate: { id: 'candidate', totals },
      limits: { seats: 5, storageBytes: 2_000_000_000 },
    });

    await expect(command.execute(memberInput)).resolves.toBe('recorded');

    expect(run).toHaveBeenCalledWith('org-1');
    expect(transaction.loadObservation).toHaveBeenCalledTimes(2);
    expect(transaction.saveObservation).toHaveBeenCalledTimes(2);
    expect(transaction.saveObservation).toHaveBeenCalledWith('active', memberInput.observation, {
      ...totals,
      seats: 4,
    });
    expect(transaction.saveObservation).toHaveBeenCalledWith('candidate', memberInput.observation, {
      ...totals,
      seats: 4,
    });
    expect(transaction.recordThresholdIntent).toHaveBeenCalledExactlyOnceWith('active', {
      metric: 'seats',
      used: 4,
      limit: 5,
      thresholdPercent: 80,
    });
  });

  it.each([1, 2])(
    'does not rewrite either generation on equal or newer version %i',
    async (version) => {
      const { command, transaction } = setup({
        active: { id: 'active', totals: { ...totals, seats: 4 } },
        candidate: { id: 'candidate', totals: { ...totals, seats: 4 } },
        limits: { seats: 5, storageBytes: 2_000_000_000 },
      });
      vi.mocked(transaction.loadObservation).mockResolvedValue({
        source: 'membership',
        sourceId: 'member-1',
        observation: { state: 'present', version, value: 'member' },
      });

      await expect(command.execute(memberInput)).resolves.toBe('unchanged');
      expect(transaction.loadObservation).toHaveBeenCalledTimes(2);
      expect(transaction.saveObservation).not.toHaveBeenCalled();
      expect(transaction.recordThresholdIntent).not.toHaveBeenCalled();
    },
  );

  it('leaves an event before bootstrap without projection writes or alerts', async () => {
    const { command, transaction } = setup({
      active: null,
      candidate: null,
      limits: { seats: 5, storageBytes: 2_000_000_000 },
    });

    await expect(command.execute(memberInput)).resolves.toBe('unchanged');
    expect(transaction.loadObservation).not.toHaveBeenCalled();
    expect(transaction.saveObservation).not.toHaveBeenCalled();
    expect(transaction.recordThresholdIntent).not.toHaveBeenCalled();
  });

  it('retains the storage crossing without creating a seat intent', async () => {
    const { command, transaction } = setup({
      active: { id: 'active', totals: { ...totals, storageBytes: 1_590_000_000 } },
      candidate: null,
      limits: { seats: 5, storageBytes: 2_000_000_000 },
    });

    await expect(
      command.execute({
        organizationId: 'org-1',
        observation: {
          source: 'attachment',
          sourceId: 'file-1',
          observation: { state: 'present', version: 1, value: 10_000_000 },
        },
      }),
    ).resolves.toBe('recorded');

    expect(transaction.recordThresholdIntent).toHaveBeenCalledExactlyOnceWith('active', {
      metric: 'storage',
      used: 1_600_000_000,
      limit: 2_000_000_000,
      thresholdPercent: 80,
    });
  });

  it('does not emit for candidate-only changes or stale active observations', async () => {
    const { command, transaction } = setup({
      active: { id: 'active', totals: { ...totals, seats: 4 } },
      candidate: { id: 'candidate', totals },
      limits: { seats: 5, storageBytes: 2_000_000_000 },
    });
    vi.mocked(transaction.loadObservation)
      .mockResolvedValueOnce(memberInput.observation)
      .mockResolvedValueOnce(null);

    await expect(command.execute(memberInput)).resolves.toBe('recorded');
    expect(transaction.saveObservation).toHaveBeenCalledTimes(1);
    expect(transaction.saveObservation).toHaveBeenCalledWith('candidate', memberInput.observation, {
      ...totals,
      seats: 4,
    });
    expect(transaction.recordThresholdIntent).not.toHaveBeenCalled();
  });

  it('propagates an intent persistence failure so the unit of work rolls back', async () => {
    const { command, transaction } = setup({
      active: { id: 'active', totals },
      candidate: null,
      limits: { seats: 5, storageBytes: 2_000_000_000 },
    });
    vi.mocked(transaction.recordThresholdIntent).mockRejectedValue(new Error('intent failed'));

    await expect(command.execute(memberInput)).rejects.toThrow('intent failed');
  });
});
