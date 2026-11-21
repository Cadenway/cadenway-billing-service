import {
  eventSchemas as organizationEvents,
  ORGANIZATION_CREATED_V1,
} from '@cadenway/contracts/events/organization-service';
import { requireOrganizationId } from '@cadenway/nest-common';
import type { EventConsumers } from '@cadenway/nest-messaging';
import type { OnApplicationBootstrap } from '@nestjs/common';

/** Local name of the durable that enrolls organizations created during or after a roster scan. */
export const usageOrganizationCreatedHandlerName = 'register-organization';

/** Enrolls organizations from the producer's creation event in the kit receipt transaction. */
export class UsageOrganizationCreatedHandler implements OnApplicationBootstrap {
  // #region Constructor
  /** Uses the kit consumer and an enrollment operation scoped to a verified organization. */
  public constructor(
    private readonly consumers: Pick<EventConsumers, 'subscribe'>,
    private readonly enrollment: {
      readonly execute: (input: { readonly organizationId: string }) => Promise<unknown>;
    },
    private readonly enabled: boolean,
  ) {}
  // #endregion

  // #region Methods
  /** Registers the durable before Billing samples the roster progress. */
  public async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) return;

    await this.consumers.subscribe({
      handler: usageOrganizationCreatedHandlerName,
      schemas: organizationEvents,
      event: ORGANIZATION_CREATED_V1,
      deliverPolicy: 'all',
      handle: async (payload, context): Promise<void> => {
        context.signal.throwIfAborted();
        const organizationId = requireOrganizationId();
        if (organizationId !== payload.organizationId) {
          throw new Error('Organization enrollment requires the source event tenant.');
        }
        await this.enrollment.execute({ organizationId });
        context.signal.throwIfAborted();
      },
    });
  }
  // #endregion
}
