import { describe, expect, it } from 'vitest';

import { QuotaUsageError } from '../../errors/quotas/quota-usage.error.js';

import { QuotaUsage } from './quota-usage.value-object.js';

describe('quota usage', () => {
  it('admits the final seat and refuses one above the limit', () => {
    const seats = new QuotaUsage('seats', 4, 5);

    expect(() => {
      seats.assertCanChangeTo(5);
    }).not.toThrow();
    expect(() => {
      seats.assertCanChangeTo(6);
    }).toThrow(QuotaUsageError);
  });

  it('keeps existing overage measurable and admits reductions and no-ops', () => {
    const seats = new QuotaUsage('seats', 7, 5);

    expect(seats.used).toBe(7);
    expect(() => {
      seats.assertCanChangeTo(6);
    }).not.toThrow();
    expect(() => {
      seats.assertCanChangeTo(7);
    }).not.toThrow();
    expect(() => {
      seats.assertCanChangeTo(8);
    }).toThrow(QuotaUsageError);
  });

  it('compares storage at the exact byte limit', () => {
    const storage = new QuotaUsage('storage', 1_999_999_999, 2_000_000_000);

    expect(() => {
      storage.assertCanChangeTo(2_000_000_000);
    }).not.toThrow();
    expect(() => {
      storage.assertCanChangeTo(2_000_000_001);
    }).toThrow(QuotaUsageError);
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid usage of %s even when the change would be a reduction',
    (used) => {
      const seats = new QuotaUsage('seats', 7, 5);

      expect(() => new QuotaUsage('seats', used, 5)).toThrow(QuotaUsageError);
      expect(() => {
        seats.assertCanChangeTo(used);
      }).toThrow(QuotaUsageError);
      expect(() => seats.thresholdCrossedAt(used)).toThrow(QuotaUsageError);
    },
  );

  it.each([0, -1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid limit of %s',
    (limit) => {
      expect(() => new QuotaUsage('seats', 0, limit)).toThrow(QuotaUsageError);
    },
  );

  it('produces the 80 percent fact at the fourth seat', () => {
    expect(new QuotaUsage('seats', 3, 5).thresholdCrossedAt(4)).toEqual({
      metric: 'seats',
      used: 4,
      limit: 5,
      thresholdPercent: 80,
    });
  });

  it('produces one 80 percent fact when measured usage jumps over the limit', () => {
    expect(
      new QuotaUsage('storage', 1_599_999_999, 2_000_000_000).thresholdCrossedAt(2_000_000_001),
    ).toEqual({
      metric: 'storage',
      used: 2_000_000_001,
      limit: 2_000_000_000,
      thresholdPercent: 80,
    });
  });

  it('stays silent below 80 percent, while falling, and while already at or above 80 percent', () => {
    expect(new QuotaUsage('storage', 79, 100).thresholdCrossedAt(79)).toBeUndefined();
    expect(new QuotaUsage('storage', 80, 100).thresholdCrossedAt(79)).toBeUndefined();
    expect(new QuotaUsage('storage', 80, 100).thresholdCrossedAt(80)).toBeUndefined();
    expect(new QuotaUsage('storage', 80, 100).thresholdCrossedAt(90)).toBeUndefined();
    expect(new QuotaUsage('storage', 90, 100).thresholdCrossedAt(95)).toBeUndefined();
  });

  it('distinguishes the exact threshold and the byte below it near the safe integer boundary', () => {
    const limit = Number.MAX_SAFE_INTEGER;
    const firstAtThreshold = 7_205_759_403_792_793;
    const previous = new QuotaUsage('storage', firstAtThreshold - 2, limit);

    expect(previous.thresholdCrossedAt(firstAtThreshold - 1)).toBeUndefined();
    expect(previous.thresholdCrossedAt(firstAtThreshold)).toMatchObject({
      used: firstAtThreshold,
      limit,
      thresholdPercent: 80,
    });
  });
});
