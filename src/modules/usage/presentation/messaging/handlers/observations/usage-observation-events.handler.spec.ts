import {
  MEMBER_JOINED_V1,
  MEMBER_REMOVED_V1,
  MEMBER_ROLE_CHANGED_V1,
} from '@cadenway/contracts/events/organization-service';
import { FILE_DELETED_V1, FILE_UPLOADED_V1 } from '@cadenway/contracts/events/storage-service';
import type { EventConsumers, EventContext } from '@cadenway/nest-messaging';
import { describe, expect, it, vi } from 'vitest';

import type { RecordUsageObservation } from '../../../../application/use-cases/commands/observations/record-usage-observation/record-usage-observation.use-case.js';
import { UsageObservationEventsHandler } from './usage-observation-events.handler.js';

const organizationId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f';
const memberId = '019a7005-6f7a-7b8c-9d0e-1f2a3b4c5d41';
const fileId = '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b01';
const envelope = {
  id: '019a7005-6f7a-7b8c-9d0e-1f2a3b4c5d40',
  organizationId,
  occurredAt: '2026-11-20T14:08:00Z',
  actor: { type: 'user', id: '019a7005-6f7a-7b8c-9d0e-1f2a3b4c5d42' },
  version: 1,
};
const membership = { ...envelope, memberId, userId: envelope.actor.id, role: 'guest' };
const file = { ...envelope, fileId, taskKey: 'CAD-482', sizeBytes: 18_400 };

function fixture(enabled = true) {
  const subscribe = vi.fn<EventConsumers['subscribe']>().mockResolvedValue(undefined);
  const execute = vi.fn<RecordUsageObservation['execute']>().mockResolvedValue('recorded');
  const handler = new UsageObservationEventsHandler({ subscribe }, { execute }, enabled);

  return { handler, subscribe, execute };
}

function delivery(signal = new AbortController().signal) {
  const claimVersion = vi.fn<EventContext['claimVersion']>().mockResolvedValue(true);
  return { claimVersion, deliveryCount: 1, streamSequence: 42, redelivered: false, signal };
}

describe('usage observation durables', () => {
  it('leaves broker subscriptions disabled until their permissions are configured', async () => {
    const { handler, subscribe } = fixture(false);
    await handler.onApplicationBootstrap();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('preserves the producer IDs and versions for live contributions and tombstones', async () => {
    const { handler, subscribe, execute } = fixture();
    await handler.onApplicationBootstrap();

    const context = delivery();
    const deliveries = [
      [MEMBER_JOINED_V1, { ...membership, invitationId: null }],
      [
        MEMBER_ROLE_CHANGED_V1,
        { ...membership, role: 'member', previousRole: 'guest', version: 2 },
      ],
      [MEMBER_REMOVED_V1, { ...membership, role: 'member', version: 3 }],
      [FILE_UPLOADED_V1, file],
      [FILE_DELETED_V1, { ...file, version: 2 }],
    ] as const;

    expect(subscribe.mock.calls.map(([registration]) => registration.handler)).toEqual([
      'record-member-joined',
      'record-member-role-changed',
      'record-member-removed',
      'record-file-uploaded',
      'record-file-deleted',
    ]);
    for (const [event, payload] of deliveries) {
      const registration = subscribe.mock.calls.find(
        ([candidate]) => candidate.event === event,
      )?.[0];
      if (registration === undefined)
        throw new Error('None of the durables uses the producer event.');
      expect(registration.deliverPolicy).toBe('all');
      expect(registration.schemas[event]?.safeParse(payload).success).toBe(true);
      await registration.handle(payload, context);
    }

    expect(execute.mock.calls).toEqual([
      [
        {
          organizationId,
          observation: {
            source: 'membership',
            sourceId: memberId,
            observation: { state: 'present', version: 1, value: 'guest' },
          },
        },
      ],
      [
        {
          organizationId,
          observation: {
            source: 'membership',
            sourceId: memberId,
            observation: { state: 'present', version: 2, value: 'member' },
          },
        },
      ],
      [
        {
          organizationId,
          observation: {
            source: 'membership',
            sourceId: memberId,
            observation: { state: 'absent', version: 3 },
          },
        },
      ],
      [
        {
          organizationId,
          observation: {
            source: 'attachment',
            sourceId: fileId,
            observation: { state: 'present', version: 1, value: 18_400 },
          },
        },
      ],
      [
        {
          organizationId,
          observation: {
            source: 'attachment',
            sourceId: fileId,
            observation: { state: 'absent', version: 2 },
          },
        },
      ],
    ]);
    expect(context.claimVersion).not.toHaveBeenCalled();
  });

  it('lets the kit retry a failed use case and skips an aborted delivery', async () => {
    const { handler, subscribe, execute } = fixture();
    await handler.onApplicationBootstrap();
    const registration = subscribe.mock.calls.find(
      ([candidate]) => candidate.event === FILE_UPLOADED_V1,
    )?.[0];
    if (registration === undefined) throw new Error('The upload durable is missing.');

    const shutdown = new Error('Shutdown interrupted the delivery.');
    await expect(registration.handle(file, delivery(AbortSignal.abort(shutdown)))).rejects.toBe(
      shutdown,
    );
    expect(execute).not.toHaveBeenCalled();

    const transactionError = new Error('Projection transaction failed.');
    execute.mockRejectedValueOnce(transactionError);
    await expect(registration.handle(file, delivery())).rejects.toBe(transactionError);
  });
});
