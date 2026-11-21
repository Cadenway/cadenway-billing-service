import {
  eventSchemas,
  ORGANIZATION_CREATED_V1,
} from '@cadenway/contracts/events/organization-service';
import { runWithOrganizationContext } from '@cadenway/nest-common';
import type { EventConsumers, EventContext } from '@cadenway/nest-messaging';
import { describe, expect, it, vi } from 'vitest';

import { usageObservationHandlerNames } from './usage-observation-events.handler.js';
import { UsageOrganizationCreatedHandler } from './usage-organization-created.handler.js';

const organizationId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f';
const ownerUserId = '019a7005-6f7a-7b8c-9d0e-1f2a3b4c5d42';
const atelierNord = eventSchemas[ORGANIZATION_CREATED_V1].parse({
  id: '019a7005-6f7a-7b8c-9d0e-1f2a3b4c5d40',
  occurredAt: '2026-11-20T14:08:00Z',
  organizationId,
  actor: { type: 'user', id: ownerUserId },
  version: 1,
  name: 'Atelier Nord',
  slug: 'atelier-nord',
  defaultLanguage: 'fr',
  plan: 'free',
  ownerUserId,
  teamSize: '1-5',
  primaryUse: 'product-engineering',
});

function fixture(enabled = true) {
  const subscribe = vi.fn<EventConsumers['subscribe']>().mockResolvedValue(undefined);
  const execute = vi.fn<(input: { readonly organizationId: string }) => Promise<void>>();
  const handler = new UsageOrganizationCreatedHandler({ subscribe }, { execute }, enabled);
  return { subscribe, execute, handler };
}

function delivery() {
  const claimVersion = vi.fn<EventContext['claimVersion']>().mockResolvedValue(true);
  return {
    claimVersion,
    deliveryCount: 1,
    streamSequence: 45,
    redelivered: false,
    signal: new AbortController().signal,
  };
}

describe('organization enrollment durable', () => {
  it('tracks the roster durable and forwards only the verified organization', async () => {
    const { subscribe, execute, handler } = fixture();
    await handler.onApplicationBootstrap();

    const registration = subscribe.mock.calls[0]?.[0];
    if (registration === undefined) throw new Error('The organization durable is missing.');
    expect(registration).toMatchObject({
      handler: 'register-organization',
      event: ORGANIZATION_CREATED_V1,
      deliverPolicy: 'all',
    });
    expect(registration.schemas).toBe(eventSchemas);
    expect(usageObservationHandlerNames).toContain('register-organization');

    const context = delivery();
    await runWithOrganizationContext(
      { organizationId, actor: { type: 'user', id: ownerUserId }, role: null, scopes: [] },
      () => registration.handle(atelierNord, context),
    );
    expect(execute).toHaveBeenCalledExactlyOnceWith({ organizationId });
    expect(context.claimVersion).not.toHaveBeenCalled();
  });

  it('refuses a different organization context before enrolling the creation', async () => {
    const { subscribe, execute, handler } = fixture();
    await handler.onApplicationBootstrap();
    const registration = subscribe.mock.calls[0]?.[0];
    if (registration === undefined) throw new Error('The organization durable is missing.');

    await expect(
      runWithOrganizationContext(
        {
          organizationId: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b30',
          actor: { type: 'user', id: ownerUserId },
          role: null,
          scopes: [],
        },
        () => registration.handle(atelierNord, delivery()),
      ),
    ).rejects.toThrow('Organization enrollment requires the source event tenant.');
    expect(execute).not.toHaveBeenCalled();
  });

  it('leaves the roster durable disabled alongside the other source consumers', async () => {
    const { subscribe, handler } = fixture(false);
    await handler.onApplicationBootstrap();
    expect(subscribe).not.toHaveBeenCalled();
  });
});
