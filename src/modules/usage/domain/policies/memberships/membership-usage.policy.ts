/**
 * Measures one membership as an occupied seat or a guest.
 * Organisation › Quotas et usage counts active guests separately. P5 uses current Organization
 * memberships, so pending invitations and removed memberships contribute nothing.
 */
export function membershipUsage(
  membership:
    | { readonly state: 'active'; readonly role: 'owner' | 'admin' | 'member' | 'guest' }
    | { readonly state: 'invited' | 'removed' },
): { readonly seats: 0 | 1; readonly guests: 0 | 1 } {
  if (membership.state !== 'active') return { seats: 0, guests: 0 };
  if (membership.role === 'guest') return { seats: 0, guests: 1 };
  return { seats: 1, guests: 0 };
}
