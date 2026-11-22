import { GetBillingEntitlementInternalResponse } from '@cadenway/contracts/validators/internal/billing-service';
import {
  InternalAccess,
  principalOf,
  ProblemException,
  requireOrganizationId,
} from '@cadenway/nest-common';
import { Controller, Get, Header, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { z } from 'zod';

import { GetBillingEntitlement } from '../../../../application/use-cases/queries/subscriptions/get-billing-entitlement/get-billing-entitlement.use-case.js';

/** Supplies the committed plan to the services that enforce organization quotas. */
@Controller('internal/v1/billing/entitlement')
@InternalAccess({
  issuers: ['organization-service', 'storage-service'],
  actors: ['system'],
  organization: 'required',
})
export class BillingEntitlementController {
  // #region Constructor
  /** Binds the same entitlement query used by Billing's own usage views. */
  public constructor(private readonly entitlement: GetBillingEntitlement) {}
  // #endregion

  // #region Methods
  /** Reads the organization claimed by the verified service without consulting Stripe. */
  @Get()
  @Header('Cache-Control', 'private, no-store')
  public async get(
    @Req() request: Request,
  ): Promise<z.output<typeof GetBillingEntitlementInternalResponse>> {
    const principal = principalOf(request);
    if (principal === undefined)
      throw new ProblemException({ status: 401, code: 'auth.token-missing' });
    if (principal.actor.id !== principal.issuer) {
      throw new ProblemException({ status: 403, code: 'auth.actor-not-allowed' });
    }
    if (Object.keys(request.query).length !== 0) {
      throw new ProblemException({
        status: 400,
        code: 'request.invalid',
        details: { issues: [{ in: 'query', path: '', code: 'unrecognized_keys' }] },
      });
    }

    const organizationId = requireOrganizationId();
    try {
      return GetBillingEntitlementInternalResponse.parse(
        await this.entitlement.execute({ organizationId }),
      );
    } catch {
      throw new ProblemException({ status: 503, code: 'billing.unavailable' });
    }
  }
  // #endregion
}
