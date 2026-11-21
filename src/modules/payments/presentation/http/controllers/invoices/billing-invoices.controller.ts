import {
  ListBillingInvoicesInternalQueryParams,
  ListBillingInvoicesInternalResponse,
} from '@cadenway/contracts/validators/internal/billing-service';
import {
  InternalAccess,
  ProblemException,
  requireOrganizationId,
  ZodValidationPipe,
} from '@cadenway/nest-common';
import { Controller, Get, Header, Query } from '@nestjs/common';
import type { z } from 'zod';

import { ListBillingInvoices } from '../../../../application/use-cases/queries/invoices/list-billing-invoices/list-billing-invoices.use-case.js';

/** Lists invoices belonging to the organization in the verified gateway token. */
@Controller('internal/v1/billing/invoices')
@InternalAccess({ issuers: ['api-gateway'], actors: ['user'], organization: 'required' })
export class BillingInvoicesController {
  // #region Constructor
  /** Receives the invoice query. */
  public constructor(private readonly invoices: ListBillingInvoices) {}
  // #endregion

  // #region Methods
  /** Returns only contracted invoice fields and preserves opaque cursor errors. */
  @Get()
  @Header('Cache-Control', 'private, no-store')
  public async get(
    @Query(new ZodValidationPipe(ListBillingInvoicesInternalQueryParams))
    query: z.output<typeof ListBillingInvoicesInternalQueryParams>,
  ): Promise<z.output<typeof ListBillingInvoicesInternalResponse>> {
    const organizationId = requireOrganizationId();
    let result: Awaited<ReturnType<ListBillingInvoices['execute']>>;
    try {
      result = await this.invoices.execute({ ...query, organizationId });
    } catch {
      throw new ProblemException({ status: 503, code: 'billing.unavailable' });
    }
    if (result.status === 'invalid-cursor') {
      throw new ProblemException({ status: 400, code: 'billing.invalid-cursor' });
    }
    if (result.status !== 'ok') {
      throw new ProblemException({ status: 503, code: 'billing.unavailable' });
    }
    const response = ListBillingInvoicesInternalResponse.safeParse(result.page);
    if (!response.success) {
      throw new ProblemException({ status: 503, code: 'billing.unavailable' });
    }
    return response.data;
  }
  // #endregion
}
