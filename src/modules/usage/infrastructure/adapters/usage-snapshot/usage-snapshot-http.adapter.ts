import { isDeepStrictEqual } from 'node:util';

import type {
  BillingMembership,
  ListBillingMembershipsInternalParams,
  ListBillingOrganizationsInternalParams,
} from '@cadenway/contracts/types/internal/organization-service';
import type {
  BillingAttachmentUsage,
  ListBillingAttachmentUsageInternalParams,
} from '@cadenway/contracts/types/internal/storage-service';
import {
  ListBillingMembershipsInternalQueryParams,
  ListBillingMembershipsInternalResponse,
  ListBillingOrganizationsInternalQueryParams,
  ListBillingOrganizationsInternalResponse,
} from '@cadenway/contracts/validators/internal/organization-service';
import {
  ListBillingAttachmentUsageInternalQueryParams,
  ListBillingAttachmentUsageInternalResponse,
} from '@cadenway/contracts/validators/internal/storage-service';
import { MAX_CALL_TIMEOUT_MS, ProblemException, remainingBudgetMs } from '@cadenway/nest-common';
import type { InternalHttpClient } from '@cadenway/nest-common';
import { assertNoActiveTransaction } from '@cadenway/nest-common/database';
import type { z } from 'zod';

import type { UsageSnapshotPage } from '../../../application/models/usage-snapshot/usage-snapshot-page.model.js';
import type { UsageSnapshotQuery } from '../../../application/models/usage-snapshot/usage-snapshot-query.model.js';
import type { UsageSnapshotSource } from '../../../application/ports/outbound/http/snapshot/usage-snapshot-source.port.js';
import { UsageSnapshotReadError } from '../../../domain/errors/usage-snapshot/usage-snapshot-read.error.js';

type InternalSnapshotClient = Pick<InternalHttpClient, 'fetch'>;

interface SnapshotOperation<Item, Params> {
  // #region Properties
  /** Relative endpoint owned by the Organization or Storage service. */
  readonly path: string;

  /** Query schema from the published internal OpenAPI operation. */
  readonly params: z.ZodType<Params>;

  /** Page schema from the same published operation. */
  readonly page: z.ZodType<UsageSnapshotPage<Item>>;

  /** Identifies each source row for ordering and progress checks. */
  readonly identify: (item: Item) => string;

  /** Only the membership source can confirm that the organization does not exist. */
  readonly reportsMissingOrganization?: true;
  // #endregion
}

const roster: SnapshotOperation<string, ListBillingOrganizationsInternalParams> = {
  path: '/internal/v1/billing-organizations',
  params: ListBillingOrganizationsInternalQueryParams,
  page: ListBillingOrganizationsInternalResponse,
  identify: (id) => id,
};

const memberships: SnapshotOperation<BillingMembership, ListBillingMembershipsInternalParams> = {
  path: '/internal/v1/billing-memberships',
  params: ListBillingMembershipsInternalQueryParams,
  page: ListBillingMembershipsInternalResponse,
  identify: (item) => item.memberId,
  reportsMissingOrganization: true,
};

const attachments: SnapshotOperation<
  BillingAttachmentUsage,
  ListBillingAttachmentUsageInternalParams
> = {
  path: '/internal/v1/billing-attachment-usage',
  params: ListBillingAttachmentUsageInternalQueryParams,
  page: ListBillingAttachmentUsageInternalResponse,
  identify: (item) => item.fileId,
};

const MAX_PAGE_BYTES = 1_048_576;

/** Fetches the three Billing snapshots with audience-specific signed kit clients. */
export class UsageSnapshotHttpAdapter implements UsageSnapshotSource {
  // #region Constructor
  /** Takes clients bound to organization-service and storage-service, respectively. */
  public constructor(
    private readonly organization: InternalSnapshotClient,
    private readonly storage: InternalSnapshotClient,
  ) {}
  // #endregion

  // #region Methods
  /** Reads the global roster with a null organization claim. */
  public async listOrganizations(
    query: UsageSnapshotQuery,
  ): ReturnType<UsageSnapshotSource['listOrganizations']> {
    const page = await this.read(this.organization, roster, null, query);
    return { items: page.items.map((id) => id.toLowerCase()), nextCursor: page.nextCursor };
  }

  /** Converts membership rows into versioned seat observations. */
  public async listMemberships(
    organizationId: string,
    query: UsageSnapshotQuery,
  ): ReturnType<UsageSnapshotSource['listMemberships']> {
    const page = await this.read(this.organization, memberships, organizationId, query);
    return {
      items: page.items.map((item) => ({
        source: 'membership',
        sourceId: item.memberId.toLowerCase(),
        observation:
          item.state === 'active'
            ? { state: 'present', version: item.version, value: item.role }
            : { state: 'absent', version: item.version },
      })),
      nextCursor: page.nextCursor,
    };
  }

  /** Converts attachment rows into versioned verified-byte observations. */
  public async listAttachments(
    organizationId: string,
    query: UsageSnapshotQuery,
  ): ReturnType<UsageSnapshotSource['listAttachments']> {
    const page = await this.read(this.storage, attachments, organizationId, query);
    return {
      items: page.items.map((item) => ({
        source: 'attachment',
        sourceId: item.fileId.toLowerCase(),
        observation:
          item.state === 'ready'
            ? { state: 'present', version: item.version, value: item.sizeBytes }
            : { state: 'absent', version: item.version },
      })),
      nextCursor: page.nextCursor,
    };
  }

  private async read<Item, Params extends { readonly cursor?: string; readonly limit?: number }>(
    owner: InternalSnapshotClient,
    operation: SnapshotOperation<Item, Params>,
    organizationId: string | null,
    query: UsageSnapshotQuery,
  ): Promise<UsageSnapshotPage<Item>> {
    assertNoActiveTransaction();
    const caller = query.signal;
    if (caller?.aborted) throw new UsageSnapshotReadError('cancelled');

    const input = operation.params.safeParse({
      cursor: query.cursor ?? undefined,
      limit: query.limit,
    });
    if (!input.success || input.data.limit === undefined) {
      throw new UsageSnapshotReadError('invalid-query');
    }
    const { limit, cursor } = input.data;
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor !== undefined) params.set('cursor', cursor);

    const budget = Math.floor(
      Math.min(MAX_CALL_TIMEOUT_MS, remainingBudgetMs() ?? MAX_CALL_TIMEOUT_MS),
    );
    if (budget <= 0) throw new UsageSnapshotReadError('unavailable');
    const expires = performance.now() + budget;
    const timeout = AbortSignal.timeout(budget);
    const signal = caller === undefined ? timeout : AbortSignal.any([caller, timeout]);

    try {
      const response = await owner.fetch(`${operation.path}?${params.toString()}`, {
        claims: { actor: { type: 'system', id: 'billing-service' }, organizationId },
        cache: 'no-store',
        redirect: 'error',
        signal,
      });
      const wire = await readPageBody(response, signal);
      const page = operation.page.safeParse(wire);
      if (!page.success || !isDeepStrictEqual(wire, page.data)) {
        throw new UsageSnapshotReadError('unavailable');
      }
      assertAdvancingPage(page.data, operation.identify, limit, cursor);
      signal.throwIfAborted();
      if (performance.now() >= expires) throw new UsageSnapshotReadError('unavailable');
      return page.data;
    } catch (error) {
      if (caller?.aborted) throw new UsageSnapshotReadError('cancelled');
      if (!signal.aborted && performance.now() < expires && error instanceof ProblemException) {
        const { status, code } = error.problem;
        if (
          operation.reportsMissingOrganization &&
          status === 404 &&
          code === 'organization.not-found'
        ) {
          throw new UsageSnapshotReadError('organization-not-found');
        }
        if (status === 400 && code === 'request.invalid' && cursor !== undefined) {
          throw new UsageSnapshotReadError('invalid-cursor');
        }
      }
      throw new UsageSnapshotReadError('unavailable');
    }
  }
  // #endregion
}

function assertAdvancingPage<Item>(
  page: UsageSnapshotPage<Item>,
  identify: (item: Item) => string,
  limit: number,
  cursor: string | undefined,
): void {
  if (
    page.items.length > limit ||
    (page.nextCursor !== null && (page.items.length === 0 || page.nextCursor === cursor))
  ) {
    throw new UsageSnapshotReadError('unavailable');
  }
  let previousId = '';
  for (const item of page.items) {
    const id = identify(item).toLowerCase();
    if (id <= previousId) throw new UsageSnapshotReadError('unavailable');
    previousId = id;
  }
}

async function readPageBody(response: Response, signal: AbortSignal): Promise<unknown> {
  const { body, headers } = response;
  const contentType = headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  const cachePolicy = headers
    .get('cache-control')
    ?.split(',')
    .map((part) => part.trim().toLowerCase());
  const size = headers.get('content-length');
  if (
    response.status !== 200 ||
    body === null ||
    contentType !== 'application/json' ||
    cachePolicy?.length !== 2 ||
    !cachePolicy.includes('private') ||
    !cachePolicy.includes('no-store') ||
    (size !== null && (!/^\d+$/u.test(size) || Number(size) > MAX_PAGE_BYTES))
  ) {
    void body?.cancel().catch(() => undefined);
    throw new UsageSnapshotReadError('unavailable');
  }

  const reader = body.getReader();
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    signal.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_PAGE_BYTES) throw new UsageSnapshotReadError('unavailable');
      chunks.push(value);
    }
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
    const document: unknown = JSON.parse(decoded);
    return document;
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}
