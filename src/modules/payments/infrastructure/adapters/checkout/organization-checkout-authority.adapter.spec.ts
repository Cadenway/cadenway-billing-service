import type { InternalHttpClient } from '@cadenway/nest-common';
import { describe, expect, it, vi } from 'vitest';

import type { BillingEntitlement } from '../../../application/models/subscriptions/billing-entitlement.model.js';
import { createOrganizationCheckoutAuthority } from './organization-checkout-authority.adapter.js';

const organizationId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f';
const providerKey = 'checkout_fixture';
const settings = {
  priceId: 'price_team_fixture',
  successUrl: 'https://app.example.test/billing?checkout=success',
  cancelUrl: 'https://app.example.test/billing?checkout=cancel',
};
const free: BillingEntitlement = {
  plan: 'free',
  seatLimit: 5,
  storageByteLimit: 2_000_000_000,
  version: 0,
};
const page = {
  items: [
    { memberId: memberId(1), state: 'active', role: 'owner', version: 1 },
    { memberId: memberId(2), state: 'active', role: 'admin', version: 1 },
    { memberId: memberId(3), state: 'active', role: 'guest', version: 1 },
    { memberId: memberId(4), state: 'removed', version: 4 },
    { memberId: memberId(5), state: 'active', role: 'member', version: 1 },
    { memberId: memberId(6), state: 'active', role: 'member', version: 1 },
    { memberId: memberId(7), state: 'active', role: 'member', version: 1 },
  ],
  nextCursor: null,
};

function memberId(suffix: number): string {
  return `019a5f3d-1a2b-7c3d-8e4f-5a6b7c8d9e${suffix.toString(16).padStart(2, '0')}`;
}

function snapshot(body: unknown, cacheControl = 'private, no-store'): Response {
  return Response.json(body, { headers: { 'Cache-Control': cacheControl } });
}

function fixture(entitlement: BillingEntitlement = free) {
  const fetch = vi.fn<InternalHttpClient['fetch']>();
  const readEntitlement = vi.fn<(org: string) => Promise<BillingEntitlement>>();
  readEntitlement.mockResolvedValue(entitlement);
  return {
    fetch,
    readEntitlement,
    ...createOrganizationCheckoutAuthority({ fetch }, readEntitlement, settings),
  };
}

describe('Organization Checkout seat authority', () => {
  it('uses one signed complete tenant snapshot and excludes guests and removals', async () => {
    const authority = fixture();
    authority.fetch.mockResolvedValueOnce(snapshot(page));

    await expect(authority.prepare(organizationId, providerKey)).resolves.toEqual({
      organizationId,
      providerKey,
      ...settings,
      quantity: 5,
    });
    expect(authority.readEntitlement).toHaveBeenCalledExactlyOnceWith(organizationId);
    expect(authority.fetch).toHaveBeenCalledTimes(1);
    expect(authority.fetch.mock.calls[0]).toMatchObject([
      '/internal/v1/billing-memberships?limit=100',
      {
        claims: { actor: { type: 'system', id: 'billing-service' }, organizationId },
        cache: 'no-store',
        redirect: 'error',
      },
    ]);
  });

  it.each([
    { ...page, nextCursor: 'valid-continuation' },
    { ...page, items: page.items.slice(0, -1) },
    { ...page, items: [...page.items, page.items[0]] },
    { ...page, items: [{ ...page.items[0], role: 'external' }, ...page.items.slice(1)] },
    {
      ...page,
      items: [{ ...page.items[0], organizationId: 'other-tenant' }, ...page.items.slice(1)],
    },
  ])('fails closed on incomplete, unsafe or too-small seat evidence %j', async (invalid) => {
    const authority = fixture();
    authority.fetch.mockResolvedValueOnce(snapshot(invalid));
    await expect(authority.prepare(organizationId, providerKey)).resolves.toBeNull();
    expect(authority.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...free, plan: 'team' as const },
    { ...free, storageByteLimit: 100_000_000_001 },
  ])(
    'fails closed before reading Organization when committed limits prohibit Checkout',
    async (entitlement) => {
      const authority = fixture(entitlement);
      await expect(authority.prepare(organizationId, providerKey)).resolves.toBeNull();
      expect(authority.fetch).not.toHaveBeenCalled();
    },
  );

  it('fails closed when Organization is unreachable or serves cached evidence', async () => {
    const authority = fixture();
    authority.fetch.mockRejectedValueOnce(new Error('upstream details'));
    authority.fetch.mockResolvedValueOnce(snapshot(page, 'public, max-age=60'));
    await expect(authority.prepare(organizationId, providerKey)).resolves.toBeNull();
    await expect(authority.prepare(organizationId, providerKey)).resolves.toBeNull();
  });

  it('rejects an oversized body even when Organization omits Content-Length', async () => {
    const authority = fixture();
    authority.fetch.mockResolvedValueOnce(
      new Response(new Uint8Array(1_048_577), {
        headers: { 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json' },
      }),
    );
    await expect(authority.prepare(organizationId, providerKey)).resolves.toBeNull();
  });
});
