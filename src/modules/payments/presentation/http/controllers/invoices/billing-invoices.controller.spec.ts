import { ListBillingInvoicesInternalQueryParams } from '@cadenway/contracts/validators/internal/billing-service';
import {
  ProblemException,
  runWithOrganizationContext,
  ZodValidationPipe,
} from '@cadenway/nest-common';
import { describe, expect, it, vi } from 'vitest';

import type { ListBillingInvoices } from '../../../../application/use-cases/queries/invoices/list-billing-invoices/list-billing-invoices.use-case.js';

import { BillingInvoicesController } from './billing-invoices.controller.js';

const organizationId = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e10';
const context = {
  organizationId,
  actor: { type: 'user' as const, id: '01938f6e-8a42-7d5b-b2c9-5e1f3a6d9c24' },
  role: null,
  scopes: [],
};
const invoice = {
  number: 'FAC-2026-001',
  periodStart: '2026-10-01T00:00:00Z',
  periodEnd: '2026-11-01T00:00:00Z',
  totalMinorUnits: 1800,
  currency: 'EUR',
  status: 'paid',
  pdfUrl: 'https://example.test/invoice.pdf',
};

describe('BillingInvoicesController', () => {
  it('uses the verified organization and strips private provider fields', async () => {
    const execute = vi.fn().mockResolvedValue({
      status: 'ok',
      page: { items: [{ ...invoice, customerId: 'private' }], nextCursor: 'next' },
    });
    const controller = new BillingInvoicesController({ execute } as unknown as ListBillingInvoices);

    const result = await runWithOrganizationContext(context, () =>
      controller.get({ cursor: 'previous', limit: 20 }),
    );

    expect(execute).toHaveBeenCalledWith({ organizationId, cursor: 'previous', limit: 20 });
    expect(result).toEqual({ items: [invoice], nextCursor: 'next' });
  });

  it.each([
    ['invalid-cursor', { status: 'invalid-cursor' }, 400, 'billing.invalid-cursor'],
    ['unavailable', { status: 'unavailable' }, 503, 'billing.unavailable'],
    [
      'invalid response',
      {
        status: 'ok',
        page: {
          items: [{ ...invoice, pdfUrl: 'http://example.test/invoice.pdf' }],
          nextCursor: null,
        },
      },
      503,
      'billing.unavailable',
    ],
  ])('maps %s without exposing provider details', async (_label, value, status, code) => {
    const controller = new BillingInvoicesController({
      execute: vi.fn().mockResolvedValue(value),
    } as unknown as ListBillingInvoices);

    await expect(
      runWithOrganizationContext(context, () => controller.get({ limit: 50 })),
    ).rejects.toMatchObject({ status, response: { code } });
  });

  it('maps an unexpected failure to a safe unavailable problem', async () => {
    const controller = new BillingInvoicesController({
      execute: vi.fn().mockRejectedValue(new Error('private provider data')),
    } as unknown as ListBillingInvoices);

    await expect(
      runWithOrganizationContext(context, () => controller.get({ limit: 50 })),
    ).rejects.toMatchObject({ status: 503, response: { code: 'billing.unavailable' } });
  });

  it('requires the verified organization before querying', async () => {
    const execute = vi.fn();
    const controller = new BillingInvoicesController({ execute } as unknown as ListBillingInvoices);
    await expect(controller.get({ limit: 50 })).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('invoice query validation', () => {
  const pipe = new ZodValidationPipe(ListBillingInvoicesInternalQueryParams);
  const metadata = { type: 'query' as const, metatype: Object };

  it('uses the contract default and converts a bounded limit', () => {
    expect(pipe.transform({}, metadata)).toEqual({ limit: 50 });
    expect(pipe.transform({ limit: '100', cursor: 'next' }, metadata)).toEqual({
      limit: 100,
      cursor: 'next',
    });
  });

  it.each([
    { limit: '0' },
    { limit: '101' },
    { limit: '1.5' },
    { limit: ['1', '2'] },
    { cursor: '' },
    { cursor: 'x'.repeat(1025) },
    { cursor: ['one', 'two'] },
    { unexpected: 'value' },
  ])('rejects invalid pagination %o', (input) => {
    expect(() => pipe.transform(input, metadata)).toThrow(ProblemException);
  });
});
