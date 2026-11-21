import { describe, expect, it, vi } from 'vitest';

import type { StripeBindingReader } from '../../../../ports/outbound/persistence/subscriptions/stripe-binding-reader.port.js';
import type { StripeInvoiceProvider } from '../../../../ports/outbound/providers/invoices/stripe-invoice-provider.port.js';
import type { InvoiceCursor } from '../../../../ports/outbound/security/invoices/invoice-cursor.port.js';
import { ListBillingInvoices } from './list-billing-invoices.use-case.js';

const binding = {
  revision: 2,
  binding: { customerId: 'cus_fixture', subscriptionId: 'sub_fixture' },
};
const invoice = {
  number: 'FAC-2026-001',
  periodStart: '2026-11-01T00:00:00Z',
  periodEnd: '2026-12-01T00:00:00Z',
  totalMinorUnits: 1234,
  currency: 'EUR',
  status: 'paid',
  pdfUrl: null,
};

/** Supplies bounded provider and authenticated cursor fixtures. */
function setup(): {
  readonly bindings: StripeBindingReader;
  readonly provider: StripeInvoiceProvider;
  readonly cursors: InvoiceCursor;
  readonly useCase: ListBillingInvoices;
} {
  const bindings: StripeBindingReader = { read: vi.fn().mockResolvedValue(binding) };
  const provider: StripeInvoiceProvider = {
    list: vi.fn().mockResolvedValue({
      invoices: [{ customerId: 'cus_fixture', liveMode: false, issued: true, invoice }],
      next: 'in_next',
    }),
  };
  const cursors: InvoiceCursor = {
    open: vi.fn().mockResolvedValue('in_previous'),
    seal: vi.fn().mockResolvedValue('authenticated-next'),
  };
  return {
    bindings,
    provider,
    cursors,
    useCase: new ListBillingInvoices(bindings, provider, cursors, false),
  };
}

describe('ListBillingInvoices', () => {
  it('returns an empty first page for an organization without a binding', async () => {
    const { bindings, provider, useCase } = setup();
    vi.mocked(bindings.read).mockResolvedValue(null);
    await expect(useCase.execute({ organizationId: 'org-a', limit: 50 })).resolves.toEqual({
      status: 'ok',
      page: { items: [], nextCursor: null },
    });
    expect(provider.list).not.toHaveBeenCalled();
    await expect(
      useCase.execute({ organizationId: 'org-a', limit: 50, cursor: 'opaque' }),
    ).resolves.toEqual({
      status: 'invalid-cursor',
    });
  });

  it('binds the cursor to tenant, customer and mode, then fences the result', async () => {
    const { bindings, provider, cursors, useCase } = setup();
    await expect(
      useCase.execute({ organizationId: 'org-a', limit: 50, cursor: 'opaque' }),
    ).resolves.toEqual({
      status: 'ok',
      page: { items: [invoice], nextCursor: 'authenticated-next' },
    });
    expect(cursors.open).toHaveBeenCalledWith({
      organizationId: 'org-a',
      customerId: 'cus_fixture',
      liveMode: false,
      cursor: 'opaque',
    });
    expect(provider.list).toHaveBeenCalledOnce();
    expect(provider.list).toHaveBeenCalledWith({
      customerId: 'cus_fixture',
      liveMode: false,
      limit: 50,
      after: 'in_previous',
    });
    expect(cursors.seal).toHaveBeenCalledWith({
      organizationId: 'org-a',
      customerId: 'cus_fixture',
      liveMode: false,
      position: 'in_next',
    });
    expect(bindings.read).toHaveBeenCalledTimes(2);
  });

  it('rejects an unauthenticated cursor before contacting Stripe', async () => {
    const { cursors, provider, useCase } = setup();
    vi.mocked(cursors.open).mockResolvedValue(null);
    await expect(
      useCase.execute({ organizationId: 'org-b', limit: 2, cursor: 'other-tenant' }),
    ).resolves.toEqual({
      status: 'invalid-cursor',
    });
    expect(provider.list).not.toHaveBeenCalled();
  });

  it('rejects an oversized cursor before reading a tenant or contacting Stripe', async () => {
    const { bindings, provider, useCase } = setup();
    await expect(
      useCase.execute({ organizationId: 'org-a', limit: 2, cursor: 'a'.repeat(1025) }),
    ).resolves.toEqual({ status: 'invalid-cursor' });
    expect(bindings.read).not.toHaveBeenCalled();
    expect(provider.list).not.toHaveBeenCalled();
  });

  it.each([
    { customerId: 'cus_other', liveMode: false, issued: true, invoice },
    { customerId: 'cus_fixture', liveMode: true, issued: true, invoice },
    { customerId: 'cus_fixture', liveMode: false, issued: false, invoice },
  ])('fails closed when a provider row is outside the current binding', async (entry) => {
    const { provider, useCase } = setup();
    vi.mocked(provider.list).mockResolvedValue({ invoices: [entry], next: null });
    await expect(useCase.execute({ organizationId: 'org-a', limit: 2 })).resolves.toEqual({
      status: 'unavailable',
    });
  });

  it('does not return a page read during a customer replacement', async () => {
    const { bindings, useCase } = setup();
    vi.mocked(bindings.read)
      .mockResolvedValueOnce(binding)
      .mockResolvedValueOnce({
        revision: 3,
        binding: { customerId: 'cus_new', subscriptionId: 'sub_new' },
      });
    await expect(useCase.execute({ organizationId: 'org-a', limit: 2 })).resolves.toEqual({
      status: 'unavailable',
    });
  });
});
