import type { EventConsumers, MessagingConnection } from '@cadenway/nest-messaging';
import { describe, expect, it, vi } from 'vitest';

import type { UsageRebuildBrokerProgress } from '../../../application/models/rebuild/usage-rebuild-broker-progress.model.js';
import { JetStreamUsageBrokerProgressAdapter } from './jetstream-usage-broker-progress.adapter.js';

const handlers = [
  'record-member-joined',
  'record-member-role-changed',
  'record-member-removed',
  'record-file-uploaded',
  'record-file-deleted',
  'register-organization',
] as const;

const progress: UsageRebuildBrokerProgress = {
  stream: 'EVENTS',
  createdAt: '2026-11-21T13:50:49.123456789Z',
  firstSequence: 1,
  lastSequence: 30,
  retainedGapCount: 0,
  consumers: handlers.map((handler) => ({
    handler,
    createdAt: '2026-11-21T13:51:49.123456789Z',
    deliveredSequence: 25,
    ackFloorSequence: 22,
    pending: 0,
    ackPending: 0,
  })),
};

function makeAdapter() {
  const listeners = new Set<(available: boolean) => void>();
  const stop = vi.fn(() => {
    listeners.clear();
  });
  const watchAvailability = vi.fn<MessagingConnection['watchAvailability']>((listener) => {
    listeners.add(listener);
    listener(true);
    return stop;
  });
  const isConsumerAdvisoryStreamClear = vi
    .fn<MessagingConnection['isConsumerAdvisoryStreamClear']>()
    .mockResolvedValue(true);
  const readProgress = vi.fn<EventConsumers['readProgress']>().mockResolvedValue(progress);
  const adapter = new JetStreamUsageBrokerProgressAdapter(
    { watchAvailability, isConsumerAdvisoryStreamClear },
    { readProgress },
    handlers,
  );
  return { adapter, listeners, stop, isConsumerAdvisoryStreamClear, readProgress };
}

describe('Billing JetStream progress capture', () => {
  it('checks the exact persistent advisory configuration before and after the sample', async () => {
    const { adapter, stop, isConsumerAdvisoryStreamClear, readProgress } = makeAdapter();
    expect(await adapter.read()).toEqual({ progress, advisoriesClear: true });
    expect(readProgress).toHaveBeenCalledWith(handlers, expect.any(AbortSignal));
    expect(isConsumerAdvisoryStreamClear).toHaveBeenCalledTimes(2);
    for (const call of isConsumerAdvisoryStreamClear.mock.calls) {
      expect(call).toEqual([
        'BILLING_REBUILD_ADVISORIES',
        'EVENTS',
        handlers.map((name) => `billing-service__${name}`),
        expect.any(AbortSignal),
      ]);
    }
    expect(isConsumerAdvisoryStreamClear).toHaveBeenCalledBefore(readProgress);
    expect(isConsumerAdvisoryStreamClear.mock.invocationCallOrder[1]).toBeGreaterThan(
      readProgress.mock.invocationCallOrder[0] ?? 0,
    );
    expect(stop).toHaveBeenCalledOnce();
  });

  it('keeps progress for comparison when the terminal advisory latch stops being clear', async () => {
    const { adapter, isConsumerAdvisoryStreamClear } = makeAdapter();
    isConsumerAdvisoryStreamClear.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    expect(await adapter.read()).toEqual({ progress, advisoriesClear: false });
  });

  it('drops the sample on a loss and restoration of availability between reads', async () => {
    const { adapter, listeners, stop, isConsumerAdvisoryStreamClear, readProgress } = makeAdapter();
    readProgress.mockImplementation(() => {
      for (const listener of listeners) {
        listener(false);
        listener(true);
      }
      return Promise.resolve(progress);
    });

    expect(await adapter.read()).toBeNull();
    expect(isConsumerAdvisoryStreamClear).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('drops an unavailable or wrong-stream broker sample', async () => {
    const { adapter, isConsumerAdvisoryStreamClear, readProgress, stop } = makeAdapter();
    readProgress
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ ...progress, stream: 'RESTRICTED' });

    expect(await adapter.read()).toBeNull();
    expect(await adapter.read()).toBeNull();
    expect(isConsumerAdvisoryStreamClear).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('cancels the entire capture when the caller aborts', async () => {
    const { adapter, isConsumerAdvisoryStreamClear, readProgress, stop } = makeAdapter();
    const caller = new AbortController();
    isConsumerAdvisoryStreamClear.mockImplementation(() => {
      caller.abort();
      return Promise.resolve(true);
    });

    expect(await adapter.read(caller.signal)).toBeNull();
    expect(readProgress).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
  });
});
