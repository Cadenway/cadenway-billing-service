import { generateKeyPairSync } from 'node:crypto';

import {
  InternalHttpClient,
  InternalTokenSigner,
  InternalTokenVerifier,
  ProblemException,
  runWithDeadline,
} from '@cadenway/nest-common';
import type { Ed25519PublicJwk } from '@cadenway/nest-common';
import { describe, expect, it, vi } from 'vitest';

import { UsageSnapshotHttpAdapter } from './usage-snapshot-http.adapter.js';

const organizationId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f';
const historicalOrganizationId = '139a5f3c-8d2e-4c4a-9b1f-3e5d7a9c1b2f';
const guestId = '019a5f3d-1a2b-7c3d-8e4f-5a6b7c8d9e41';
const removedId = '019a5f3d-1a2b-7c3d-8e4f-5a6b7c8d9e42';
const readyId = '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f15';
const deletedId = '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f16';
const responseHeaders = {
  'Cache-Control': 'private, no-store',
  'Content-Type': 'application/json',
};
const emptyPage = { items: [], nextCursor: null };

function json(page: unknown): Response {
  return Response.json(page, { headers: responseHeaders });
}

describe('Billing usage snapshot HTTP adapter', () => {
  it('signs each export for its owner and turns removals and deletions into terminal observations', async () => {
    const { x, d } = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
    if (x === undefined || d === undefined)
      throw new Error('Cannot construct the synthetic signer.');
    const publicJwk: Ed25519PublicJwk = { kty: 'OKP', crv: 'Ed25519', kid: 'billing-test', x };
    const signer = await InternalTokenSigner.create({
      issuer: 'billing-service',
      privateJwk: { ...publicJwk, d },
    });
    const cursor = 'owner-cursor +/=?';

    async function ownerClient(
      service: string,
      pages: Readonly<Record<string, unknown>>,
    ): Promise<InternalHttpClient> {
      const verifier = await InternalTokenVerifier.create({
        audience: service,
        trustedIssuers: { 'billing-service': [publicJwk] },
      });
      return new InternalHttpClient({
        service,
        baseUrl: `http://${service}`,
        signer,
        fetch: async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : input);
          const isRoster = url.pathname === '/internal/v1/billing-organizations';
          const headers = new Headers(init?.headers);
          const bearer = headers.get('authorization');
          if (!bearer?.startsWith('Bearer ')) throw new Error('Missing bearer.');
          expect(await verifier.verify(bearer.slice(7))).toMatchObject({
            actor: { type: 'system', id: 'billing-service' },
            issuer: 'billing-service',
            audience: service,
            organizationId: isRoster ? null : organizationId,
            role: null,
            scopes: [],
          });
          expect(url.hostname).toBe(service);
          expect(url.searchParams.get('cursor')).toBe(isRoster ? null : cursor);
          expect(url.searchParams.get('limit')).toBe(isRoster ? '50' : '2');
          expect(url.searchParams.has('organizationId')).toBe(false);
          expect(init).toMatchObject({ method: 'GET', cache: 'no-store', redirect: 'error' });
          if (!Object.hasOwn(pages, url.pathname)) throw new Error('Unexpected source route.');
          return json(pages[url.pathname]);
        },
      });
    }

    const client = new UsageSnapshotHttpAdapter(
      await ownerClient('organization-service', {
        '/internal/v1/billing-organizations': {
          items: [organizationId.toUpperCase(), historicalOrganizationId],
          nextCursor: 'next-roster',
        },
        '/internal/v1/billing-memberships': {
          items: [
            { memberId: guestId, state: 'active', role: 'guest', version: 1 },
            { memberId: removedId, state: 'removed', version: 3 },
          ],
          nextCursor: 'next-membership',
        },
      }),
      await ownerClient('storage-service', {
        '/internal/v1/billing-attachment-usage': {
          items: [
            { fileId: readyId, state: 'ready', sizeBytes: 248320, version: 1 },
            { fileId: deletedId, state: 'deleted', version: 2 },
          ],
          nextCursor: null,
        },
      }),
    );
    await expect(client.listOrganizations({ cursor: null })).resolves.toEqual({
      items: [organizationId, historicalOrganizationId],
      nextCursor: 'next-roster',
    });
    await expect(client.listMemberships(organizationId, { cursor, limit: 2 })).resolves.toEqual({
      items: [
        {
          source: 'membership',
          sourceId: guestId,
          observation: { state: 'present', version: 1, value: 'guest' },
        },
        { source: 'membership', sourceId: removedId, observation: { state: 'absent', version: 3 } },
      ],
      nextCursor: 'next-membership',
    });
    await expect(client.listAttachments(organizationId, { cursor, limit: 2 })).resolves.toEqual({
      items: [
        {
          source: 'attachment',
          sourceId: readyId,
          observation: { state: 'present', version: 1, value: 248320 },
        },
        { source: 'attachment', sourceId: deletedId, observation: { state: 'absent', version: 2 } },
      ],
      nextCursor: null,
    });
  });

  it('refuses invalid outbound limits and cursors before calling an owner', async () => {
    const fetch = vi.fn<InternalHttpClient['fetch']>();
    const client = new UsageSnapshotHttpAdapter({ fetch }, { fetch });
    await expect(client.listOrganizations({ cursor: 'a'.repeat(1025) })).rejects.toMatchObject({
      reason: 'invalid-query',
    });
    await expect(
      client.listAttachments(organizationId, { cursor: null, limit: 101 }),
    ).rejects.toMatchObject({
      reason: 'invalid-query',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports an owner-refused continuation without retaining request or upstream details', async () => {
    const cursor = 'opaque-continuation';
    const problem = new ProblemException({
      status: 400,
      code: 'request.invalid',
      detail: 'Untrusted upstream detail.',
      details: { cursor },
    });
    const owner = { fetch: vi.fn<InternalHttpClient['fetch']>().mockRejectedValue(problem) };
    const client = new UsageSnapshotHttpAdapter(owner, owner);
    const error: unknown = await client
      .listOrganizations({ cursor })
      .catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      name: 'UsageSnapshotReadError',
      reason: 'invalid-cursor',
      message: 'Cannot read the billing usage snapshot (invalid-cursor).',
    });
    expect(error).not.toHaveProperty('cause');
    expect(error).not.toHaveProperty('problem');
    await expect(client.listOrganizations({ cursor: null })).rejects.toMatchObject({
      reason: 'unavailable',
    });
  });

  it('treats an explicit missing organization as authoritative only for the membership endpoint', async () => {
    const owner = {
      fetch: vi
        .fn<InternalHttpClient['fetch']>()
        .mockRejectedValue(new ProblemException({ status: 404, code: 'organization.not-found' })),
    };
    const client = new UsageSnapshotHttpAdapter(owner, owner);
    await expect(client.listMemberships(organizationId, { cursor: null })).rejects.toMatchObject({
      reason: 'organization-not-found',
    });
    await expect(client.listAttachments(organizationId, { cursor: null })).rejects.toMatchObject({
      reason: 'unavailable',
    });
  });

  it.each([
    { items: [historicalOrganizationId, organizationId], nextCursor: null },
    { items: [organizationId, organizationId.toUpperCase()], nextCursor: null },
    { items: [], nextCursor: 'another-cursor' },
    { items: [organizationId], nextCursor: 'same-cursor' },
  ])('rejects a roster page that cannot move the scan forward (%#)', async (page) => {
    const owner = { fetch: () => Promise.resolve(json(page)) };
    const client = new UsageSnapshotHttpAdapter(owner, owner);
    await expect(client.listOrganizations({ cursor: 'same-cursor' })).rejects.toMatchObject({
      reason: 'unavailable',
    });
  });

  it('checks the declared page limit even if the owner stays under the contract maximum', async () => {
    const owner = {
      fetch: () =>
        Promise.resolve(
          json({ items: [organizationId, historicalOrganizationId], nextCursor: null }),
        ),
    };
    const client = new UsageSnapshotHttpAdapter(owner, owner);
    await expect(client.listOrganizations({ cursor: null, limit: 1 })).rejects.toMatchObject({
      reason: 'unavailable',
    });
  });

  it('rejects upstream fields stripped by generated validators', async () => {
    const owner = {
      fetch: () =>
        Promise.resolve(
          json({
            items: [
              {
                memberId: guestId,
                state: 'active',
                role: 'guest',
                version: 2,
                userId: historicalOrganizationId,
              },
            ],
            nextCursor: null,
          }),
        ),
    };
    const client = new UsageSnapshotHttpAdapter(owner, owner);
    await expect(client.listMemberships(organizationId, { cursor: null })).rejects.toMatchObject({
      reason: 'unavailable',
    });
  });

  it('rejects payloads without the required success media type or cache policy', async () => {
    const fetch = vi
      .fn<InternalHttpClient['fetch']>()
      .mockResolvedValueOnce(Response.json(emptyPage))
      .mockResolvedValueOnce(
        new Response('{}', { headers: { 'Cache-Control': 'private, no-store' } }),
      );
    const client = new UsageSnapshotHttpAdapter({ fetch }, { fetch });
    await expect(client.listOrganizations({ cursor: null })).rejects.toMatchObject({
      reason: 'unavailable',
    });
    await expect(client.listOrganizations({ cursor: null })).rejects.toMatchObject({
      reason: 'unavailable',
    });
  });

  it('cancels an over-limit body even when the response provides no content length', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1_048_577));
      },
      cancel,
    });
    const owner = {
      fetch: () => Promise.resolve(new Response(body, { headers: responseHeaders })),
    };
    const client = new UsageSnapshotHttpAdapter(owner, owner);
    await expect(client.listAttachments(organizationId, { cursor: null })).rejects.toMatchObject({
      reason: 'unavailable',
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('aborts an in-flight body when its caller cancels the scan', async () => {
    const cancel = vi.fn();
    let signalRead: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      signalRead = resolve;
    });
    const body = new ReadableStream<Uint8Array>(
      {
        pull: () => {
          signalRead();
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const owner = {
      fetch: () => Promise.resolve(new Response(body, { headers: responseHeaders })),
    };
    const client = new UsageSnapshotHttpAdapter(owner, owner);
    const controller = new AbortController();
    const page = client.listOrganizations({ cursor: null, signal: controller.signal });
    await started;
    controller.abort(new Error('Local abort reason.'));
    const failure = await page.catch((error: unknown) => error);
    expect(failure).toMatchObject({ reason: 'cancelled' });
    expect(failure).not.toHaveProperty('cause');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('continues to enforce the request budget while the body is still pending', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const owner = {
      fetch: () => Promise.resolve(new Response(body, { headers: responseHeaders })),
    };
    const client = new UsageSnapshotHttpAdapter(owner, owner);
    const keepAlive = setInterval(() => undefined, 25);
    try {
      await expect(
        runWithDeadline(125, () => client.listOrganizations({ cursor: null })),
      ).rejects.toMatchObject({
        reason: 'unavailable',
      });
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      clearInterval(keepAlive);
    }
  });
});
