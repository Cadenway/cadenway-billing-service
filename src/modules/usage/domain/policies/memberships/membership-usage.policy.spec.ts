import { describe, expect, it } from 'vitest';

import { membershipUsage } from './membership-usage.policy.js';

describe('membership usage', () => {
  it.each(['owner', 'admin', 'member'] as const)('counts an active %s towards seats', (role) => {
    expect(membershipUsage({ state: 'active', role })).toEqual({ seats: 1, guests: 0 });
  });

  it('counts an active guest separately from occupied seats', () => {
    expect(membershipUsage({ state: 'active', role: 'guest' })).toEqual({ seats: 0, guests: 1 });
  });

  it.each(['invited', 'removed'] as const)('excludes a membership in state %s', (state) => {
    expect(membershipUsage({ state })).toEqual({ seats: 0, guests: 0 });
  });
});
