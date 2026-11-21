import { describe, expect, it } from 'vitest';

import type { UsageRebuildBrokerProgress } from '../../../application/models/rebuild/usage-rebuild-broker-progress.model.js';
import { BillingUsageBrokerProof } from './billing-usage-broker-proof.adapter.js';

const handlers = [
  'record-member-joined',
  'record-member-role-changed',
  'record-member-removed',
  'record-file-uploaded',
  'record-file-deleted',
  'register-organization',
] as const;

const streamCreatedAt = '2026-11-21T13:50:49.123456789Z';
const consumerCreatedAt = '2026-11-21T13:51:49.123456789Z';

const start: UsageRebuildBrokerProgress = {
  stream: 'EVENTS',
  createdAt: streamCreatedAt,
  firstSequence: 10,
  lastSequence: 25,
  retainedGapCount: 0,
  consumers: handlers.map((handler) => ({
    handler,
    createdAt: consumerCreatedAt,
    deliveredSequence: 20,
    ackFloorSequence: 18,
    pending: 2,
    ackPending: 1,
  })),
};

const finish: UsageRebuildBrokerProgress = {
  ...start,
  lastSequence: 45,
  consumers: start.consumers.map((consumer) => ({
    ...consumer,
    deliveredSequence: 42,
    ackFloorSequence: 30,
    pending: 0,
    ackPending: 0,
  })),
};

const proof = new BillingUsageBrokerProof(handlers);

type ConsumerProgress = UsageRebuildBrokerProgress['consumers'][number];

function withRegistration(changes: Partial<ConsumerProgress>): UsageRebuildBrokerProgress {
  return {
    ...finish,
    consumers: finish.consumers.map((consumer) =>
      consumer.handler === 'register-organization' ? { ...consumer, ...changes } : consumer,
    ),
  };
}

describe('Billing JetStream usage broker proof', () => {
  it('accepts a known baseline even with backlog and allows retention up to its fence', () => {
    expect(proof.validStart(start, true)).toBe(true);
    expect(proof.assess(start, { ...finish, firstSequence: 26 }, true)).toBe('covered');
  });

  it('accepts settled filtered durables below the head, with different delivered and ACK cursors', () => {
    expect(proof.assess(start, finish, true)).toBe('covered');
  });

  it('requires the configured stream and all six distinct consumers', () => {
    expect(proof.validStart({ ...start, stream: 'RESTRICTED' }, true)).toBe(false);
    expect(proof.validStart(withRegistration({ handler: 'record-file-uploaded' }), true)).toBe(
      false,
    );
    expect(proof.assess(start, { ...finish, consumers: finish.consumers.slice(0, -1) }, true)).toBe(
      'pending',
    );
  });

  it.each([{ pending: 1 }, { ackPending: 1 }])(
    'waits for remaining work in the register-organization durable %j',
    (pending) => {
      expect(proof.assess(start, withRegistration(pending), true)).toBe('pending');
    },
  );

  it('blocks on unavailable advisory clearance', () => {
    expect(proof.validStart(start, false)).toBe(false);
    expect(proof.assess(start, finish, false)).toBe('pending');
  });

  it('invalidates same-name stream or durable replacement at nanosecond precision', () => {
    expect(
      proof.assess(start, { ...finish, createdAt: '2026-11-21T13:50:49.123456790Z' }, true),
    ).toBe('lost');
    expect(
      proof.assess(start, withRegistration({ createdAt: '2026-11-21T13:51:49.123456790Z' }), true),
    ).toBe('lost');
  });

  it('invalidates retention past the fence even when the advisory check is unavailable', () => {
    expect(proof.assess(start, { ...finish, firstSequence: 27 }, false)).toBe('lost');
  });

  it('invalidates a new retained gap or uncertain gaps behind an advancing floor', () => {
    expect(proof.assess(start, { ...finish, retainedGapCount: 1 }, true)).toBe('lost');
    const startWithGap = { ...start, retainedGapCount: 1 };
    expect(
      proof.assess(startWithGap, { ...finish, retainedGapCount: 1, firstSequence: 11 }, true),
    ).toBe('lost');
    expect(proof.assess(startWithGap, { ...finish, retainedGapCount: 1 }, true)).toBe('covered');
    expect(proof.assess(startWithGap, { ...finish, firstSequence: 11 }, true)).toBe('covered');
  });

  it('invalidates regressed stream and consumer positions', () => {
    expect(proof.assess(start, { ...finish, lastSequence: 24 }, true)).toBe('lost');
    expect(proof.assess(start, withRegistration({ ackFloorSequence: 17 }), true)).toBe('lost');
    expect(
      proof.assess(start, withRegistration({ deliveredSequence: 19, ackFloorSequence: 18 }), true),
    ).toBe('lost');
  });
});
