import { ListBillingInvoicesInternalResponse } from '@cadenway/contracts/validators/internal/billing-service';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createStripeInvoiceProvider } from './stripe-invoice-provider.adapter.js';

const sdk = vi.hoisted(() => ({
  configure: vi.fn<(options: unknown) => void>(),
  list: vi.fn<(input: unknown) => Promise<unknown>>(),
}));

vi.mock('stripe', () => ({
  default: class {
    // #region Properties
    /** Exposes only the configured list operation. */
    public readonly invoices = { list: sdk.list };
    // #endregion

    // #region Constructor
    /** Records transport policies without retaining the synthetic credential. */
    public constructor(_credential: string, options: unknown) {
      sdk.configure(options);
    }
    // #endregion
  },
}));

const request = { customerId: 'cus_fixture', liveMode: false, limit: 3, after: 'in_previous' };
const paid = {
  object: 'invoice',
  id: 'in_paid',
  customer: request.customerId,
  livemode: false,
  created: 1_791_216_000,
  status: 'paid',
  number: 'FAC-2026-001',
  status_transitions: { finalized_at: 1_791_216_000 },
  period_start: 1_791_216_000,
  period_end: 1_793_894_400,
  total: -150,
  currency: 'eur',
  invoice_pdf: 'https://invoice.example.test/invoice.pdf',
};
const draft = {
  object: 'invoice',
  id: 'in_draft',
  customer: request.customerId,
  livemode: false,
  created: paid.created - 1,
  status: 'draft',
};

function page(data: readonly unknown[], hasMore = false) {
  return { object: 'list', has_more: hasMore, data };
}

function provider(liveMode = false) {
  return createStripeInvoiceProvider('fixture-credential-placeholder', liveMode);
}

describe('Stripe invoice provider', () => {
  beforeEach(() => {
    sdk.configure.mockReset();
    sdk.list.mockReset();
  });

  it('reads one bounded page, validates its published shape and advances past a filtered draft', async () => {
    sdk.list.mockResolvedValue(page([{ ...paid, ignored: 'synthetic metadata' }, draft], true));

    const result = await provider().list(request);
    expect(result).toEqual({
      invoices: [
        {
          customerId: request.customerId,
          liveMode: false,
          issued: true,
          invoice: {
            number: paid.number,
            periodStart: new Date(paid.period_start * 1_000).toISOString(),
            periodEnd: new Date(paid.period_end * 1_000).toISOString(),
            totalMinorUnits: -150,
            currency: 'EUR',
            status: 'paid',
            pdfUrl: paid.invoice_pdf,
          },
        },
      ],
      next: draft.id,
    });
    expect(
      ListBillingInvoicesInternalResponse.safeParse({
        items: result.invoices.map(({ invoice }) => invoice),
        nextCursor: result.next,
      }).success,
    ).toBe(true);
    expect(sdk.configure).toHaveBeenCalledExactlyOnceWith({
      timeout: 5_000,
      maxNetworkRetries: 0,
      telemetry: false,
    });
    expect(sdk.list).toHaveBeenCalledExactlyOnceWith({
      customer: request.customerId,
      limit: request.limit,
      starting_after: request.after,
    });
  });

  it('returns an empty visible page with a continuation when its only row is a draft', async () => {
    sdk.list.mockResolvedValue(page([draft], true));

    await expect(provider().list({ ...request, after: null })).resolves.toEqual({
      invoices: [],
      next: draft.id,
    });
    expect(sdk.list).toHaveBeenCalledExactlyOnceWith({
      customer: request.customerId,
      limit: request.limit,
    });
  });

  it('preserves newest-first order, accepts finalized new statuses and handles a missing PDF', async () => {
    sdk.list.mockResolvedValue(
      page([
        { ...paid, customer: { object: 'customer', id: request.customerId, livemode: false } },
        {
          ...paid,
          id: 'in_other',
          created: paid.created - 1,
          number: 'FAC-2',
          status: 'future-status',
          invoice_pdf: undefined,
        },
      ]),
    );
    const result = await provider().list(request);
    expect(result.next).toBeNull();
    expect(
      result.invoices.map(({ invoice }) => [invoice.number, invoice.status, invoice.pdfUrl]),
    ).toEqual([
      [paid.number, 'paid', paid.invoice_pdf],
      ['FAC-2', 'future-status', null],
    ]);
  });

  it.each([
    { customerId: 'cus_wrong/path' },
    { liveMode: true },
    { limit: 0 },
    { limit: 101 },
    { after: 'other_wrong' },
  ])('rejects an invalid or wrong-mode request before calling Stripe', async (patch) => {
    await expect(provider().list({ ...request, ...patch })).rejects.toThrow(
      'Stripe invoice history is unavailable.',
    );
    expect(sdk.list).not.toHaveBeenCalled();
  });

  it.each([
    page([{ ...draft, customer: 'cus_other' }]),
    page([{ ...paid, livemode: true }]),
    page([{ ...paid, customer: { object: 'customer', id: request.customerId, livemode: true } }]),
    page([{ ...paid, customer: { object: 'customer', id: request.customerId, deleted: true } }]),
    page([{ ...paid, id: request.after }]),
    page([paid, paid]),
    page([draft, paid]),
    page([paid, draft, {}, {}]),
    page([], true),
    page([{ ...paid, number: null }]),
    page([{ ...paid, status_transitions: { finalized_at: null } }]),
    page([{ ...paid, period_end: paid.period_start - 1 }]),
    page([{ ...paid, invoice_pdf: 'http://invoice.example.test/invoice.pdf' }]),
    page([{ ...paid, invoice_pdf: 'https://synthetic-user@invoice.example.test/invoice.pdf' }]),
    page([{ ...paid, total: Number.MAX_SAFE_INTEGER + 1 }]),
  ])('rejects untrusted provider evidence without returning a partial page', async (response) => {
    sdk.list.mockResolvedValue(response);
    await expect(provider().list(request)).rejects.toThrow(
      'Stripe invoice history is unavailable.',
    );
    expect(sdk.list).toHaveBeenCalledTimes(1);
  });

  it('returns an opaque error without provider internals or automatic retry', async () => {
    sdk.list.mockRejectedValue(new Error('private upstream details'));
    await expect(provider().list(request)).rejects.toThrow(
      /^Stripe invoice history is unavailable\.$/u,
    );
    expect(sdk.list).toHaveBeenCalledTimes(1);
  });
});
