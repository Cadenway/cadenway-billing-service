import { describe, expect, it, vi } from 'vitest';

import type { UsageRebuildBrokerProgress } from '../../../../models/rebuild/usage-rebuild-broker-progress.model.js';
import type { UsageRebuildCandidate } from '../../../../models/rebuild/usage-rebuild-candidate.model.js';
import type { UsageBrokerProof } from '../../../../ports/outbound/messaging/rebuild/usage-broker-proof.port.js';
import type { UsageRebuildTransaction } from '../../../../ports/outbound/transactions/rebuild/usage-rebuild-transaction.port.js';
import type { UsageRebuildUnitOfWork } from '../../../../ports/outbound/transactions/rebuild/usage-rebuild-unit-of-work.port.js';
import { StartUsageRebuild } from '../start-usage-rebuild/start-usage-rebuild.use-case.js';
import { PromoteUsageRebuild } from './promote-usage-rebuild.use-case.js';

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
  version: 5,
  totals: { seats: 1, guests: 0, storageBytes: 256 },
  membership: { cursor: null, complete: true },
  attachment: { cursor: null, complete: true },
  brokerAtStart: broker,
  advisory: { createdAt: 'latch', lastSequence: 0 },
};
const input = {
  organizationId: 'organization',
  generationId: 'generation',
  expectedCandidateVersion: 5,
  brokerAtPromotion: broker,
  advisoriesClear: true,
  advisory: { createdAt: 'latch', lastSequence: 0 },
};

function setup(current: UsageRebuildCandidate | null): {
  readonly transaction: UsageRebuildTransaction;
  readonly proof: UsageBrokerProof;
  readonly start: StartUsageRebuild;
  readonly promote: PromoteUsageRebuild;
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
  const proof: UsageBrokerProof = {
    validStart: vi.fn().mockReturnValue(true),
    assess: vi.fn().mockReturnValue('covered'),
  };
  const unit: UsageRebuildUnitOfWork = {
    async run<T>(
      _organizationId: string,
      work: (tx: UsageRebuildTransaction) => Promise<T>,
    ): Promise<T> {
      return work(transaction);
    },
  };
  return {
    transaction,
    proof,
    start: new StartUsageRebuild(unit, proof),
    promote: new PromoteUsageRebuild(unit, proof),
  };
}

describe('usage rebuild generation', () => {
  it('resumes an existing candidate without replacing its original event checkpoint', async () => {
    const { start, transaction, proof } = setup(candidate);
    await expect(
      start.execute({
        organizationId: 'organization',
        brokerAtStart: broker,
        advisoriesClear: false,
        advisory: { createdAt: 'latch', lastSequence: 0 },
      }),
    ).resolves.toEqual({ generationId: 'generation', created: false });
    expect(proof.validStart).not.toHaveBeenCalled();
    expect(transaction.startCandidate).not.toHaveBeenCalled();
  });

  it('requires independently confirmed evidence before creating a candidate', async () => {
    const { start, transaction, proof } = setup(null);
    vi.mocked(proof.validStart).mockReturnValueOnce(false);
    const request = {
      organizationId: 'organization',
      brokerAtStart: broker,
      advisoriesClear: false,
      advisory: { createdAt: 'latch', lastSequence: 0 },
    };
    await expect(start.execute(request)).rejects.toThrow();
    expect(transaction.startCandidate).not.toHaveBeenCalled();
    await expect(start.execute({ ...request, advisoriesClear: true })).resolves.toEqual({
      generationId: 'generation',
      created: true,
    });
    expect(transaction.startCandidate).toHaveBeenCalledOnce();
  });

  it('rejects a candidate when an advisory was recorded and purged during the rebuild', async () => {
    const { promote, transaction } = setup(candidate);
    await expect(
      promote.execute({ ...input, advisory: { createdAt: 'latch', lastSequence: 1 } }),
    ).resolves.toBe('invalidated');
    expect(transaction.abandon).toHaveBeenCalledWith(candidate.id);
    expect(transaction.promote).not.toHaveBeenCalled();
  });

  it('does not promote on unknown latch evidence', async () => {
    const { promote, transaction } = setup(candidate);
    await expect(
      promote.execute({ ...input, advisoriesClear: false, advisory: null }),
    ).resolves.toBe('pending');
    expect(transaction.promote).not.toHaveBeenCalled();
    expect(transaction.abandon).not.toHaveBeenCalled();
  });

  it('checks the sampled frontier against the candidate checkpoint before switching pointers', async () => {
    const { promote, transaction, proof } = setup(candidate);
    await expect(promote.execute(input)).resolves.toBe('promoted');
    expect(proof.assess).toHaveBeenCalledWith(candidate.brokerAtStart, broker, true);
    expect(transaction.promote).toHaveBeenCalledWith('generation', broker);
  });

  it('abandons only the candidate on confirmed loss and preserves it when evidence is pending', async () => {
    const { promote, transaction, proof } = setup(candidate);
    vi.mocked(proof.assess).mockReturnValueOnce('pending').mockReturnValueOnce('lost');
    await expect(promote.execute(input)).resolves.toBe('pending');
    expect(transaction.abandon).not.toHaveBeenCalled();
    await expect(promote.execute(input)).resolves.toBe('invalidated');
    expect(transaction.abandon).toHaveBeenCalledWith('generation');
    expect(transaction.promote).not.toHaveBeenCalled();
  });

  it('requires both completed source scans and the exact version observed before the sample', async () => {
    const incomplete = setup({ ...candidate, attachment: { cursor: null, complete: false } });
    await expect(incomplete.promote.execute(input)).resolves.toBe('pending');
    expect(incomplete.proof.assess).not.toHaveBeenCalled();

    const changed = setup({ ...candidate, version: 6 });
    await expect(changed.promote.execute(input)).resolves.toBe('stale');
    expect(changed.transaction.promote).not.toHaveBeenCalled();
  });
});
