import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { UsageSnapshotReadError } from '../../../domain/errors/usage-snapshot/usage-snapshot-read.error.js';
import type { UsageBrokerSample } from '../../models/rebuild/usage-broker-sample.model.js';
import type { UsageRebuildCandidate } from '../../models/rebuild/usage-rebuild-candidate.model.js';
import type { UsageRebuildState } from '../../models/rebuild/usage-rebuild-state.model.js';
import type { UsageSnapshotSource } from '../../ports/outbound/http/snapshot/usage-snapshot-source.port.js';
import type { UsageBrokerProof } from '../../ports/outbound/messaging/rebuild/usage-broker-proof.port.js';
import type { UsageBrokerSampleReader } from '../../ports/outbound/messaging/rebuild/usage-broker-sample-reader.port.js';
import type { UsageRebuildTransaction } from '../../ports/outbound/transactions/rebuild/usage-rebuild-transaction.port.js';
import type { UsageRebuildUnitOfWork } from '../../ports/outbound/transactions/rebuild/usage-rebuild-unit-of-work.port.js';
import { ApplyUsageRebuildPage } from '../../use-cases/commands/rebuild/apply-usage-rebuild-page/apply-usage-rebuild-page.use-case.js';
import { InvalidateActiveUsage } from '../../use-cases/commands/rebuild/invalidate-active-usage/invalidate-active-usage.use-case.js';
import { PromoteUsageRebuild } from '../../use-cases/commands/rebuild/promote-usage-rebuild/promote-usage-rebuild.use-case.js';
import { StartUsageRebuild } from '../../use-cases/commands/rebuild/start-usage-rebuild/start-usage-rebuild.use-case.js';
import { AdvanceUsageRebuild } from './advance-usage-rebuild.service.js';

const sample: UsageBrokerSample = {
  advisoriesClear: true,
  progress: {
    stream: 'EVENTS',
    createdAt: '2026-01-01T00:00:00Z',
    firstSequence: 1,
    lastSequence: 1,
    retainedGapCount: 0,
    consumers: [],
  },
};
const candidate: UsageRebuildCandidate = {
  id: 'candidate',
  version: 3,
  totals: { seats: 0, guests: 0, storageBytes: 0 },
  membership: { cursor: null, complete: false },
  attachment: { cursor: null, complete: false },
  brokerAtStart: sample.progress,
};

function setup(current: UsageRebuildState): {
  readonly service: AdvanceUsageRebuild;
  readonly memberships: Mock<UsageSnapshotSource['listMemberships']>;
  readonly attachments: Mock<UsageSnapshotSource['listAttachments']>;
  readonly proof: UsageBrokerProof;
  readonly transaction: UsageRebuildTransaction;
  readonly brokerRead: Mock<UsageBrokerSampleReader['read']>;
} {
  const transaction: UsageRebuildTransaction = {
    lockOrganization: vi.fn().mockResolvedValue(undefined),
    candidate: vi.fn().mockResolvedValue(current.candidate),
    startCandidate: vi.fn().mockResolvedValue('candidate'),
    loadObservation: vi.fn().mockResolvedValue(null),
    saveObservation: vi.fn().mockResolvedValue(undefined),
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
  const proof: UsageBrokerProof = {
    validStart: vi.fn().mockReturnValue(true),
    assess: vi.fn().mockReturnValue('covered'),
  };
  const memberships = vi
    .fn<UsageSnapshotSource['listMemberships']>()
    .mockResolvedValue({ items: [], nextCursor: null });
  const attachments = vi
    .fn<UsageSnapshotSource['listAttachments']>()
    .mockResolvedValue({ items: [], nextCursor: null });
  const source: UsageSnapshotSource = {
    listOrganizations: vi.fn(),
    listMemberships: memberships,
    listAttachments: attachments,
  };
  const brokerRead = vi.fn<UsageBrokerSampleReader['read']>().mockResolvedValue(sample);
  const service = new AdvanceUsageRebuild(
    { read: vi.fn().mockResolvedValue(current) },
    { read: brokerRead },
    proof,
    source,
    new StartUsageRebuild(unit, proof),
    new ApplyUsageRebuildPage(unit),
    new PromoteUsageRebuild(unit, proof),
    new InvalidateActiveUsage(unit),
    unit,
  );
  return { service, memberships, attachments, proof, transaction, brokerRead };
}

describe('AdvanceUsageRebuild', () => {
  it('keeps a healthy active generation without starting a new candidate', async () => {
    const { service, transaction } = setup({
      active: { id: 'active', version: 2, brokerAtPromotion: sample.progress },
      candidate: null,
    });
    await expect(service.advance('organization')).resolves.toBe('healthy');
    expect(transaction.startCandidate).not.toHaveBeenCalled();
    expect(transaction.checkpointActive).not.toHaveBeenCalled();
    expect(transaction.flushThresholdIntents).toHaveBeenCalledWith('active', 2);
  });

  it('advances the active continuity checkpoint when broker coverage progresses', async () => {
    const { service, transaction, brokerRead } = setup({
      active: { id: 'active', version: 2, brokerAtPromotion: sample.progress },
      candidate: null,
    });
    const newer = { ...sample, progress: { ...sample.progress, lastSequence: 2 } };
    brokerRead.mockResolvedValue(newer);

    await expect(service.advance('organization')).resolves.toBe('healthy');
    expect(transaction.lockOrganization).toHaveBeenCalledOnce();
    expect(transaction.checkpointActive).toHaveBeenCalledWith('active', 2, newer.progress);
    expect(transaction.flushThresholdIntents).toHaveBeenCalledBefore(
      vi.mocked(transaction.checkpointActive),
    );
  });

  it('does not publish pending crossings when the generation changed after the broker sample', async () => {
    const { service, transaction } = setup({
      active: { id: 'active', version: 2, brokerAtPromotion: sample.progress },
      candidate: null,
    });
    vi.mocked(transaction.flushThresholdIntents).mockResolvedValue(false);

    await expect(service.advance('organization')).resolves.toBe('stale');
    expect(transaction.checkpointActive).not.toHaveBeenCalled();
  });

  it('does not flush pending crossings while broker continuity is unconfirmed', async () => {
    const { service, transaction, proof } = setup({
      active: { id: 'active', version: 2, brokerAtPromotion: sample.progress },
      candidate: null,
    });
    vi.mocked(proof.assess).mockReturnValue('pending');

    await expect(service.advance('organization')).resolves.toBe('waiting');
    expect(transaction.flushThresholdIntents).not.toHaveBeenCalled();
  });

  it('preserves the active generation when checkpoint update loses the version race', async () => {
    const { service, transaction, brokerRead } = setup({
      active: { id: 'active', version: 2, brokerAtPromotion: sample.progress },
      candidate: null,
    });
    brokerRead.mockResolvedValue({ ...sample, progress: { ...sample.progress, lastSequence: 2 } });
    vi.mocked(transaction.checkpointActive).mockResolvedValue(false);

    await expect(service.advance('organization')).resolves.toBe('stale');
    expect(transaction.invalidateActive).not.toHaveBeenCalled();
  });

  it('invalidates active usage when the advisory latch is uncleared or unverifiable', async () => {
    const { service, transaction, proof, brokerRead } = setup({
      active: { id: 'active', version: 2, brokerAtPromotion: sample.progress },
      candidate,
    });
    brokerRead.mockResolvedValue({ ...sample, advisoriesClear: false });
    vi.mocked(proof.assess).mockReturnValue('pending');

    await expect(service.advance('organization')).resolves.toBe('invalidated');
    expect(transaction.invalidateActive).toHaveBeenCalledWith('active', null);
    expect(transaction.abandon).toHaveBeenCalledWith(candidate.id);
    expect(transaction.flushThresholdIntents).not.toHaveBeenCalled();
    expect(proof.assess).not.toHaveBeenCalled();
  });

  it('keeps a newly replaced active generation when invalidation is stale', async () => {
    const { service, transaction, brokerRead } = setup({
      active: { id: 'active', version: 2, brokerAtPromotion: sample.progress },
      candidate: null,
    });
    brokerRead.mockResolvedValue({ ...sample, advisoriesClear: false });
    vi.mocked(transaction.invalidateActive).mockResolvedValue(false);

    await expect(service.advance('organization')).resolves.toBe('stale');
    expect(transaction.invalidateActive).toHaveBeenCalledWith('active', null);
  });

  it('abandons an uncertain candidate even if the active generation changed before locking', async () => {
    const { service, transaction, brokerRead } = setup({
      active: { id: 'active', version: 2, brokerAtPromotion: sample.progress },
      candidate,
    });
    brokerRead.mockResolvedValue({ ...sample, advisoriesClear: false });
    vi.mocked(transaction.invalidateActive).mockResolvedValue(false);

    await expect(service.advance('organization')).resolves.toBe('stale');
    expect(transaction.abandon).toHaveBeenCalledWith(candidate.id);
  });

  it('waits without invalidation when no broker observation is available', async () => {
    const { service, transaction, brokerRead } = setup({
      active: { id: 'active', version: 2, brokerAtPromotion: sample.progress },
      candidate: null,
    });
    brokerRead.mockResolvedValue(null);

    await expect(service.advance('organization')).resolves.toBe('waiting');
    expect(transaction.invalidateActive).not.toHaveBeenCalled();
  });

  it('abandons a candidate when the advisory latch is uncleared', async () => {
    const { service, transaction, proof, brokerRead } = setup({ active: null, candidate });
    brokerRead.mockResolvedValue({ ...sample, advisoriesClear: false });
    vi.mocked(proof.assess).mockReturnValue('pending');

    await expect(service.advance('organization')).resolves.toBe('invalidated');
    expect(transaction.abandon).toHaveBeenCalledWith(candidate.id);
    expect(transaction.promote).not.toHaveBeenCalled();
  });

  it('leaves a replacement candidate intact after an unclear advisory observation', async () => {
    const { service, transaction, brokerRead } = setup({ active: null, candidate });
    brokerRead.mockResolvedValue({ ...sample, advisoriesClear: false });
    vi.mocked(transaction.candidate).mockResolvedValue({ ...candidate, id: 'replacement' });
    vi.mocked(transaction.invalidateActive).mockResolvedValue(false);

    await expect(service.advance('organization')).resolves.toBe('waiting');
    expect(transaction.abandon).not.toHaveBeenCalled();
  });

  it('invalidates the observed candidate if it became active before the tenant lock', async () => {
    const { service, transaction, brokerRead } = setup({ active: null, candidate });
    brokerRead.mockResolvedValue({ ...sample, advisoriesClear: false });
    vi.mocked(transaction.candidate).mockResolvedValue(null);
    vi.mocked(transaction.invalidateActive).mockResolvedValue(true);

    await expect(service.advance('organization')).resolves.toBe('invalidated');
    expect(transaction.invalidateActive).toHaveBeenCalledWith(candidate.id, null);
    expect(transaction.abandon).not.toHaveBeenCalled();
  });

  it('invalidates only the sampled active generation when continuity was lost', async () => {
    const { service, transaction, proof } = setup({
      active: { id: 'active', version: 2, brokerAtPromotion: sample.progress },
      candidate: null,
    });
    vi.mocked(proof.assess).mockReturnValue('lost');
    await expect(service.advance('organization')).resolves.toBe('invalidated');
    expect(transaction.invalidateActive).toHaveBeenCalledWith('active', 2);
  });

  it('treats an active generation changed under the lock as stale', async () => {
    const { service, transaction, proof } = setup({
      active: { id: 'active', version: 2, brokerAtPromotion: sample.progress },
      candidate: null,
    });
    vi.mocked(proof.assess).mockReturnValue('lost');
    vi.mocked(transaction.invalidateActive).mockResolvedValue(false);
    await expect(service.advance('organization')).resolves.toBe('stale');
  });

  it('starts one candidate before reading any source page', async () => {
    const { service, memberships, transaction } = setup({ active: null, candidate: null });
    await expect(service.advance('organization')).resolves.toBe('started');
    expect(transaction.startCandidate).toHaveBeenCalledWith(sample.progress);
    expect(memberships).not.toHaveBeenCalled();
  });

  it('reads exactly one page outside the write transaction and saves its checkpoint', async () => {
    const { service, memberships, attachments, transaction } = setup({ active: null, candidate });
    await expect(service.advance('organization')).resolves.toBe('applied');
    expect(memberships).toHaveBeenCalledWith('organization', {
      cursor: null,
      limit: 100,
    });
    expect(attachments).not.toHaveBeenCalled();
    expect(transaction.savePage).toHaveBeenCalledWith(
      'candidate',
      'membership',
      candidate.totals,
      null,
    );
  });

  it('abandons an invalid cursor but preserves the candidate on a temporary failure', async () => {
    const { service, memberships, transaction } = setup({ active: null, candidate });
    memberships
      .mockRejectedValueOnce(new UsageSnapshotReadError('unavailable'))
      .mockRejectedValueOnce(new UsageSnapshotReadError('invalid-cursor'));
    await expect(service.advance('organization')).rejects.toMatchObject({ reason: 'unavailable' });
    expect(transaction.abandon).not.toHaveBeenCalled();
    await expect(service.advance('organization')).resolves.toBe('invalidated');
    expect(transaction.abandon).toHaveBeenCalledWith('candidate');
  });

  it('does not abandon a candidate that changed while an invalid source cursor was checked', async () => {
    const { service, memberships, transaction } = setup({ active: null, candidate });
    memberships.mockRejectedValueOnce(new UsageSnapshotReadError('invalid-cursor'));
    vi.mocked(transaction.candidate).mockResolvedValue({ ...candidate, version: 4 });
    await expect(service.advance('organization')).resolves.toBe('stale');
    expect(transaction.abandon).not.toHaveBeenCalled();
  });

  it('promotes only after the two source scans are complete', async () => {
    const complete = {
      ...candidate,
      membership: { cursor: null, complete: true },
      attachment: { cursor: null, complete: true },
    };
    const { service, memberships, attachments, transaction } = setup({
      active: null,
      candidate: complete,
    });
    await expect(service.advance('organization')).resolves.toBe('promoted');
    expect(transaction.promote).toHaveBeenCalledWith('candidate', sample.progress);
    expect(memberships).not.toHaveBeenCalled();
    expect(attachments).not.toHaveBeenCalled();
  });
});
