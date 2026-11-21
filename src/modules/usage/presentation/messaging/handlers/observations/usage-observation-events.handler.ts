import {
  eventSchemas as organizationEvents,
  MEMBER_JOINED_V1,
  MEMBER_REMOVED_V1,
  MEMBER_ROLE_CHANGED_V1,
} from '@cadenway/contracts/events/organization-service';
import type {
  MemberJoinedV1,
  MemberRoleChangedV1,
} from '@cadenway/contracts/events/organization-service';
import {
  eventSchemas as storageEvents,
  FILE_DELETED_V1,
  FILE_UPLOADED_V1,
} from '@cadenway/contracts/events/storage-service';
import type {
  EventConsumers,
  EventNameOf,
  EventPayloadOf,
  EventSchemas,
} from '@cadenway/nest-messaging';
import type { OnApplicationBootstrap } from '@nestjs/common';

import type { RecordUsageObservationInput } from '../../../../application/use-cases/commands/observations/record-usage-observation/record-usage-observation.input.js';
import type { RecordUsageObservation } from '../../../../application/use-cases/commands/observations/record-usage-observation/record-usage-observation.use-case.js';

import { usageOrganizationCreatedHandlerName } from './usage-organization-created.handler.js';

const handlerByEvent = {
  [MEMBER_JOINED_V1]: 'record-member-joined',
  [MEMBER_ROLE_CHANGED_V1]: 'record-member-role-changed',
  [MEMBER_REMOVED_V1]: 'record-member-removed',
  [FILE_UPLOADED_V1]: 'record-file-uploaded',
  [FILE_DELETED_V1]: 'record-file-deleted',
} as const;

/** Stable local names for rebuild progress, including the organization roster's live updates. */
export const usageObservationHandlerNames: readonly string[] = [
  usageOrganizationCreatedHandlerName,
  ...Object.values(handlerByEvent),
];

function presentMembership(
  event: MemberJoinedV1 | MemberRoleChangedV1,
): RecordUsageObservationInput {
  return {
    organizationId: event.organizationId,
    observation: {
      source: 'membership',
      sourceId: event.memberId,
      observation: { state: 'present', version: event.version, value: event.role },
    },
  };
}

/** Connects source observations to durable consumers after broker permissions are provisioned. */
export class UsageObservationEventsHandler implements OnApplicationBootstrap {
  // #region Constructor
  /** Uses the kit consumer and the tenant use case for each source event. */
  public constructor(
    private readonly consumers: Pick<EventConsumers, 'subscribe'>,
    private readonly record: Pick<RecordUsageObservation, 'execute'>,
    private readonly enabled: boolean,
  ) {}
  // #endregion

  // #region Methods
  /** Registers one durable for each producer fact while ingestion is enabled. */
  public async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) return;

    await this.subscribe(organizationEvents, MEMBER_JOINED_V1, presentMembership);
    await this.subscribe(organizationEvents, MEMBER_ROLE_CHANGED_V1, presentMembership);
    await this.subscribe(organizationEvents, MEMBER_REMOVED_V1, (event) => ({
      organizationId: event.organizationId,
      observation: {
        source: 'membership',
        sourceId: event.memberId,
        observation: { state: 'absent', version: event.version },
      },
    }));
    await this.subscribe(storageEvents, FILE_UPLOADED_V1, (event) => ({
      organizationId: event.organizationId,
      observation: {
        source: 'attachment',
        sourceId: event.fileId,
        observation: { state: 'present', version: event.version, value: event.sizeBytes },
      },
    }));
    await this.subscribe(storageEvents, FILE_DELETED_V1, (event) => ({
      organizationId: event.organizationId,
      observation: {
        source: 'attachment',
        sourceId: event.fileId,
        observation: { state: 'absent', version: event.version },
      },
    }));
  }

  private subscribe<
    TSchemas extends EventSchemas,
    TName extends EventNameOf<TSchemas> & keyof typeof handlerByEvent,
  >(
    schemas: TSchemas,
    event: TName,
    map: (payload: EventPayloadOf<TSchemas, TName>) => RecordUsageObservationInput,
  ): Promise<void> {
    return this.consumers.subscribe({
      handler: handlerByEvent[event],
      schemas,
      event,
      deliverPolicy: 'all',
      handle: async (payload, context): Promise<void> => {
        context.signal.throwIfAborted();
        // The kit owns the receipt. Projection versions are compared across all five durables.
        await this.record.execute(map(payload));
        context.signal.throwIfAborted();
      },
    });
  }
  // #endregion
}
