import { describe, expect, it } from 'vitest';

import { QuotaUsageError } from '../../errors/quotas/quota-usage.error.js';

import { attachmentUsageBytes } from './attachment-usage.policy.js';

describe('attachment usage', () => {
  it('counts the verified bytes of a ready attachment', () => {
    expect(attachmentUsageBytes({ state: 'ready', verifiedSizeBytes: 84_216 })).toBe(84_216);
  });

  it.each(['pending', 'deleted'] as const)('excludes attachments in state %s', (state) => {
    expect(attachmentUsageBytes({ state })).toBe(0);
  });

  it.each([0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
    'refuses an invalid verified size of %s',
    (verifiedSizeBytes) => {
      expect(() => attachmentUsageBytes({ state: 'ready', verifiedSizeBytes })).toThrow(
        QuotaUsageError,
      );
    },
  );
});
