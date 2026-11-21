import { describe, expect, it, vi } from 'vitest';

import type { ActiveUsageReader } from '../../../../ports/outbound/persistence/usage/active-usage-reader.port.js';
import { GetBillingSubscription } from './get-billing-subscription.use-case.js';

const organizationId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f';
const freePlan = { id: 'free', seats: 5, storageBytes: 2_000_000_000 } as const;

describe('GetBillingSubscription', () => {
  it('reads the signed organization and returns seat, guest and attachment usage', async () => {
    const read = vi.fn<ActiveUsageReader['read']>().mockResolvedValue({
      seats: 4,
      guests: 2,
      storageBytes: 1_600_000_000,
    });

    await expect(
      new GetBillingSubscription({ read }, freePlan).execute({ organizationId }),
    ).resolves.toEqual({
      plan: 'free',
      seats: { used: 4, limit: 5 },
      guestCount: 2,
      storage: { attachmentBytesUsed: 1_600_000_000, limitBytes: 2_000_000_000 },
    });
    expect(read).toHaveBeenCalledExactlyOnceWith(organizationId);
  });

  it('preserves usage above the limit when reporting an existing baseline', async () => {
    const read = vi.fn<ActiveUsageReader['read']>().mockResolvedValue({
      seats: 6,
      guests: 0,
      storageBytes: 2_000_000_001,
    });

    await expect(
      new GetBillingSubscription({ read }, freePlan).execute({ organizationId }),
    ).resolves.toEqual({
      plan: 'free',
      seats: { used: 6, limit: 5 },
      guestCount: 0,
      storage: { attachmentBytesUsed: 2_000_000_001, limitBytes: 2_000_000_000 },
    });
  });

  it('reports unavailable usage instead of an empty projection', async () => {
    const read = vi.fn<ActiveUsageReader['read']>().mockResolvedValue(null);

    await expect(
      new GetBillingSubscription({ read }, freePlan).execute({ organizationId }),
    ).resolves.toBeNull();
    expect(read).toHaveBeenCalledExactlyOnceWith(organizationId);
  });

  it('reports an unavailable plan without reading usage', async () => {
    const read = vi.fn<ActiveUsageReader['read']>();

    await expect(
      new GetBillingSubscription({ read }, null).execute({ organizationId }),
    ).resolves.toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('propagates reader failures for the presentation boundary to handle', async () => {
    const failure = new Error('usage read failed');
    const read = vi.fn<ActiveUsageReader['read']>().mockRejectedValue(failure);

    await expect(
      new GetBillingSubscription({ read }, freePlan).execute({ organizationId }),
    ).rejects.toBe(failure);
  });
});
