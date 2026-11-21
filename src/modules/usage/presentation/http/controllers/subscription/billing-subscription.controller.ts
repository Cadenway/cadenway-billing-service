import { GetBillingSubscriptionInternalResponse } from '@cadenway/contracts/validators/internal/billing-service';
import {
  InternalAccess,
  ProblemException,
  requireOrganizationId,
  ZodValidationPipe,
} from '@cadenway/nest-common';
import { Controller, Get, Header, Query } from '@nestjs/common';
import type { z } from 'zod';

import { GetBillingSubscription } from '../../../../application/use-cases/queries/subscription/get-billing-subscription/get-billing-subscription.use-case.js';
import { billingSubscriptionQuery } from '../../validation/subscription/billing-subscription-query.validation.js';

/** Reads the current plan and measured usage for the gateway's verified organization. */
@Controller('internal/v1/billing/subscription')
@InternalAccess({ issuers: ['api-gateway'], actors: ['user'], organization: 'required' })
export class BillingSubscriptionController {
  // #region Constructor
  /** Receives the subscription query. */
  public constructor(private readonly subscription: GetBillingSubscription) {}
  // #endregion

  // #region Methods
  /** Returns the contracted fields only, or a 503 while measured usage is unavailable. */
  @Get()
  @Header('Cache-Control', 'private, no-store')
  public async get(
    @Query(new ZodValidationPipe(billingSubscriptionQuery))
    query: z.output<typeof billingSubscriptionQuery>,
  ): Promise<z.output<typeof GetBillingSubscriptionInternalResponse>> {
    const organizationId = requireOrganizationId();
    try {
      const result = await this.subscription.execute({ ...query, organizationId });
      const response = GetBillingSubscriptionInternalResponse.safeParse(result);
      if (!response.success)
        throw new ProblemException({ status: 503, code: 'billing.unavailable' });
      return response.data;
    } catch (error: unknown) {
      if (error instanceof ProblemException) throw error;
      throw new ProblemException({ status: 503, code: 'billing.unavailable' });
    }
  }
  // #endregion
}
