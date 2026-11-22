import { ReceiveStripeBillingWebhookInternalHeader } from '@cadenway/contracts/validators/internal/billing-service';
import { InternalAccess, principalOf, ProblemException } from '@cadenway/nest-common';
import { Controller, Header, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';

import { AdmitStripeWebhook } from '../../../../application/use-cases/commands/subscriptions/admit-stripe-webhook/admit-stripe-webhook.use-case.js';
import type { AdmitStripeWebhookOutput } from '../../../../application/use-cases/commands/subscriptions/admit-stripe-webhook/admit-stripe-webhook.output.js';

/** Checks the exact organization-free system principal forwarded by the gateway. */
function authorize(request: Request): void {
  const principal = principalOf(request);
  if (principal === undefined)
    throw new ProblemException({ status: 401, code: 'auth.token-missing' });
  if (principal.actor.type !== 'system' || principal.actor.id !== 'api-gateway') {
    throw new ProblemException({ status: 403, code: 'auth.actor-not-allowed' });
  }
  if (principal.organizationId !== null) {
    throw new ProblemException({ status: 403, code: 'auth.organization-not-allowed' });
  }
}

/** Reads a single signature instead of trusting a joined value from duplicate headers. */
function signatureOf(request: Request): string {
  const signatures = request.headersDistinct['stripe-signature'];
  const parsed = ReceiveStripeBillingWebhookInternalHeader.safeParse({
    'Stripe-Signature': signatures?.length === 1 ? signatures[0] : undefined,
  });
  if (!parsed.success) {
    throw new ProblemException({ status: 400, code: 'billing.invalid-webhook-signature' });
  }
  return parsed.data['Stripe-Signature'];
}

/** Receives verified gateway deliveries and preserves the Stripe bytes for authentication. */
@Controller('internal/v1/billing/webhooks')
@InternalAccess({ issuers: ['api-gateway'], actors: ['system'], organization: 'optional' })
export class StripeWebhookController {
  // #region Constructor
  /** Binds the durable subscription admission use case. */
  public constructor(private readonly admit: AdmitStripeWebhook) {}
  // #endregion

  // #region Methods
  /** Acknowledges durably admitted or settled deliveries, and verified unsupported types. */
  @Post('stripe')
  @HttpCode(204)
  @Header('Cache-Control', 'private, no-store')
  public async receive(@Req() request: Request): Promise<void> {
    authorize(request);
    if (
      request.is('application/json') !== 'application/json' ||
      Object.keys(request.query).length !== 0 ||
      !Buffer.isBuffer(request.body)
    ) {
      throw new ProblemException({ status: 400, code: 'billing.invalid-webhook' });
    }
    const signature = signatureOf(request);
    let outcome: AdmitStripeWebhookOutput;
    try {
      outcome = await this.admit.execute({ rawBody: request.body, signature });
    } catch {
      // Provider and database failures can contain delivery content or provider identities.
      throw new ProblemException({ status: 503, code: 'billing.unavailable' });
    }
    const refused = {
      'invalid-signature': 'billing.invalid-webhook-signature',
      'invalid-event': 'billing.invalid-webhook',
      'body-too-large': 'request.body-too-large',
    } as const;
    if (outcome === 'unavailable') {
      throw new ProblemException({ status: 503, code: 'billing.unavailable' });
    }
    if (outcome === 'accepted' || outcome === 'ignored') return;
    throw new ProblemException({ status: 400, code: refused[outcome] });
  }
  // #endregion
}
