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
};
const input = {
  organizationId: 'organization',
  generationId: 'generation',
  expectedCandidateVersion: 5,
  brokerAtPromotion: broker,
  advisoriesClear: true,
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
    loadObservation: vi.fn().mockResolvedValue(null),
    saveObservation: vi.fn().mockResolvedValue(undefined),
    savePage: vi.fn().mockResolvedValue(undefined),
    promote: vi.fn().mockResolvedValue(undefined),
    abandon: vi.fn().mockResolvedValue(undefined),
    invalidateActive: vi.fn().mockResolvedValue(true),
    checkpointActive: vi.fn().mockResolvedValue(true),
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
    };
    await expect(start.execute(request)).rejects.toThrow();
    expect(transaction.startCandidate).not.toHaveBeenCalled();
    await expect(start.execute({ ...request, advisoriesClear: true })).resolves.toEqual({
      generationId: 'generation',
      created: true,
    });
    expect(transaction.startCandidate).toHaveBeenCalledOnce();
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
