import { GetBillingActiveSeatCountInternalResponse } from '@cadenway/contracts/validators/internal/organization-service';
import { MAX_CALL_TIMEOUT_MS, remainingBudgetMs } from '@cadenway/nest-common';
import type { InternalHttpClient } from '@cadenway/nest-common';
import { assertNoActiveTransaction } from '@cadenway/nest-common/database';

import type { CheckoutProviderRequest } from '../../../application/models/checkout/checkout-provider-request.model.js';
import type { BillingEntitlement } from '../../../application/models/subscriptions/billing-entitlement.model.js';
import type { CheckoutAuthority } from '../../../application/ports/outbound/providers/checkout/checkout-authority.port.js';
import {
  effectiveTeamSeatLimit,
  teamStorageByteLimit,
} from '../../../domain/policies/subscriptions/stripe-subscription.policy.js';

type CheckoutSettings = Pick<CheckoutProviderRequest, 'priceId' | 'successUrl' | 'cancelUrl'> & {
  readonly freeSeatLimit: number;
};

const maxCountResponseBytes = 4_096;

/** Prepares Checkout from one complete Organization snapshot and Billing's committed limits. */
export function createOrganizationCheckoutAuthority(
  client: Pick<InternalHttpClient, 'fetch'>,
  readEntitlement: (organizationId: string) => Promise<BillingEntitlement>,
  settings: CheckoutSettings,
): CheckoutAuthority {
  return {
    async prepare(organizationId, providerKey): Promise<CheckoutProviderRequest | null> {
      assertNoActiveTransaction();
      const entitlement = await readEntitlement(organizationId);
      if (entitlement.plan !== 'free' || entitlement.storageByteLimit > teamStorageByteLimit) {
        return null;
      }

      const quantity = await readCurrentSeats(client, organizationId);
      if (
        quantity === null ||
        quantity < 1 ||
        effectiveTeamSeatLimit(quantity, settings.freeSeatLimit) < entitlement.seatLimit
      ) {
        return null;
      }
      const { priceId, successUrl, cancelUrl } = settings;
      return { organizationId, providerKey, quantity, priceId, successUrl, cancelUrl };
    },
  };
}

async function readCurrentSeats(
  client: Pick<InternalHttpClient, 'fetch'>,
  organizationId: string,
): Promise<number | null> {
  const timeoutMs = Math.floor(Math.min(MAX_CALL_TIMEOUT_MS, remainingBudgetMs() ?? Infinity));
  if (timeoutMs <= 0) return null;
  const deadline = performance.now() + timeoutMs;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await client.fetch('/internal/v1/billing-active-seats', {
      claims: { actor: { type: 'system', id: 'billing-service' }, organizationId },
      cache: 'no-store',
      redirect: 'error',
      signal,
      streamTimeoutMs: timeoutMs,
      idempotent: false,
    });
    const wire = await readCountBody(response, signal);
    const count = GetBillingActiveSeatCountInternalResponse.safeParse(wire);
    if (!count.success || signal.aborted || performance.now() >= deadline) return null;
    return count.data.activeSeatCount;
  } catch {
    return null;
  }
}

async function readCountBody(response: Response, signal: AbortSignal): Promise<unknown> {
  const { body, headers } = response;
  const mediaType = headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  const cachePolicy = headers
    .get('cache-control')
    ?.split(',')
    .map((directive) => directive.trim().toLowerCase());
  const size = headers.get('content-length');
  if (
    response.status !== 200 ||
    body === null ||
    mediaType !== 'application/json' ||
    cachePolicy?.length !== 2 ||
    !cachePolicy.includes('private') ||
    !cachePolicy.includes('no-store') ||
    (size !== null && (!/^\d+$/u.test(size) || Number(size) > maxCountResponseBytes))
  ) {
    void body?.cancel().catch(() => undefined);
    return null;
  }

  const reader = body.getReader();
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxCountResponseBytes) return null;
      chunks.push(chunk.value);
    }
    const document: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)),
    );
    return document;
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}
