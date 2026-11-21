import {
  eventSchemas,
  QUOTA_THRESHOLD_REACHED_V1,
  quotaThresholdReachedV1Schema,
} from '@cadenway/contracts/events/billing-service';
import type { DatabaseSchema, TransactionScope } from '@cadenway/nest-common/database';
import type { OutboxWriter } from '@cadenway/nest-messaging/outbox/writer';
import { describe, expect, it, vi } from 'vitest';

import { QuotaThresholdOutbox } from './quota-threshold-outbox.adapter.js';

const organizationId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f';
const assigned = {
  id: '019a7005-6f7a-7b8c-9d0e-1f2a3b4c5d40',
  occurredAt: '2026-11-20T14:08:00Z',
};
const crossing = { metric: 'seats', thresholdPercent: 80, used: 4, limit: 5 } as const;

function fixture() {
  const append = vi.fn<OutboxWriter['append']>().mockResolvedValue(assigned);
  const scope = {
    kind: 'tenant',
    organizationId,
    client: { query: vi.fn() },
    get db(): never {
      throw new Error('The writer owns the transaction queries.');
    },
  } satisfies TransactionScope<DatabaseSchema>;
  return { append, scope, outbox: new QuotaThresholdOutbox({ append }) };
}

describe('quota threshold outbox', () => {
  it('uses the supplied scope and the published system actor envelope', async () => {
    const { append, scope, outbox } = fixture();
    await outbox.append(scope, organizationId, 4, crossing);

    const write = append.mock.calls[0];
    expect(write?.[0]).toBe(scope);
    expect(write?.[1]).toBe(eventSchemas);
    expect(write?.[2]).toBe(QUOTA_THRESHOLD_REACHED_V1);
    expect(quotaThresholdReachedV1Schema.parse({ ...write?.[3], ...assigned })).toEqual({
      ...assigned,
      ...crossing,
      organizationId,
      actor: { type: 'system', id: 'billing-service' },
      version: 4,
    });
  });

  it('refuses a different tenant before appending a quota event', async () => {
    const { append, scope, outbox } = fixture();
    await expect(
      outbox.append(scope, '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b30', 4, crossing),
    ).rejects.toThrow('Quota threshold events require the organization transaction.');
    expect(append).not.toHaveBeenCalled();
  });

  it('propagates the append failure to the enclosing projection transaction', async () => {
    const { append, scope, outbox } = fixture();
    const failure = new Error('Outbox write failed.');
    append.mockRejectedValueOnce(failure);
    await expect(outbox.append(scope, organizationId, 4, crossing)).rejects.toBe(failure);
  });
});
