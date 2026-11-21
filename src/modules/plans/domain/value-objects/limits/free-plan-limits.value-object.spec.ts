import { describe, expect, it } from 'vitest';

import { FREE_PLAN_LIMITS } from './free-plan-limits.value-object.js';

describe('Free plan limits', () => {
  it('includes five occupied seats and two decimal gigabytes', () => {
    expect(FREE_PLAN_LIMITS).toEqual({ seats: 5, storageBytes: 2_000_000_000 });
  });
});
