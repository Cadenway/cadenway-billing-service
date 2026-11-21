import {
  StartBillingCheckoutInternalBody,
  StartBillingCheckoutInternalHeader,
  StartBillingCheckoutInternalResponse,
} from '@cadenway/contracts/validators/internal/billing-service';
import {
  InternalAccess,
  principalOf,
  ProblemException,
  requireOrganizationId,
  ZodValidationPipe,
} from '@cadenway/nest-common';
import { Body, Controller, Header, HttpCode, Inject, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';

import { StartBillingCheckout } from '../../../../application/use-cases/commands/checkout/start-billing-checkout/start-billing-checkout.use-case.js';

const noQuery = z.object({}).strict();

/** Starts or replays a hosted Checkout for the authenticated organization. */
@Controller('internal/v1/billing/checkout')
@InternalAccess({ issuers: ['api-gateway'], actors: ['user'], organization: 'required' })
export class BillingCheckoutController {
  // #region Constructor
  /** Binds the Checkout action, or a disabled provider. */
  public constructor(
    @Inject(StartBillingCheckout) private readonly checkout: StartBillingCheckout | null,
  ) {}
  // #endregion

  // #region Methods
  /** Validates the unique idempotency header and maps Checkout outcomes to the public contract. */
  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  public async post(
    @Req() request: Request,
    @Body(new ZodValidationPipe(StartBillingCheckoutInternalBody))
    body: z.output<typeof StartBillingCheckoutInternalBody>,
    @Query(new ZodValidationPipe(noQuery)) query: z.output<typeof noQuery>,
  ): Promise<z.output<typeof StartBillingCheckoutInternalResponse>> {
    if (Object.keys(query).length !== 0) {
      throw new ProblemException({ status: 400, code: 'request.invalid' });
    }
    const principal = principalOf(request);
    if (principal === undefined) {
      throw new ProblemException({ status: 401, code: 'auth.token-missing' });
    }
    if (principal.actor.type !== 'user' || principal.actor.id === null) {
      throw new ProblemException({ status: 403, code: 'auth.actor-not-allowed' });
    }
    const organizationId = requireOrganizationId();
    const keys = request.headersDistinct['idempotency-key'];
    const header = StartBillingCheckoutInternalHeader.safeParse({
      'Idempotency-Key': keys?.length === 1 ? keys[0] : undefined,
    });
    if (!header.success) {
      throw new ProblemException({
        status: 400,
        code: 'request.invalid',
        details: {
          issues: [{ in: 'header', path: 'Idempotency-Key', code: 'invalid_format' }],
        },
      });
    }
    if (this.checkout === null) {
      throw new ProblemException({ status: 503, code: 'billing.unavailable' });
    }

    let result: Awaited<ReturnType<StartBillingCheckout['execute']>>;
    try {
      result = await this.checkout.execute({
        organizationId,
        actorId: principal.actor.id,
        idempotencyKey: header.data['Idempotency-Key'],
        plan: body.plan,
      });
    } catch {
      throw new ProblemException({ status: 503, code: 'billing.unavailable' });
    }
    if (result.status === 'ready') {
      const response = StartBillingCheckoutInternalResponse.safeParse({ url: result.url });
      if (response.success) return response.data;
      throw new ProblemException({ status: 503, code: 'billing.unavailable' });
    }
    const problems = {
      'subscription-active': { status: 409, code: 'billing.subscription-active' },
      'checkout-in-progress': { status: 409, code: 'billing.checkout-in-progress' },
      'request-in-progress': { status: 409, code: 'idempotency.request-in-progress' },
      'key-reused': { status: 422, code: 'idempotency.key-reused' },
      unavailable: { status: 503, code: 'billing.unavailable' },
    } as const;
    throw new ProblemException(problems[result.status]);
  }
  // #endregion
}
