import { generateKeySync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createEncryptedInvoiceCursor } from './encrypted-invoice-cursor.adapter.js';

const scope = {
  organizationId: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b30',
  customerId: 'cus_fixture',
  liveMode: false,
};
const position = 'in_synthetic_position';

function key() {
  return generateKeySync('aes', { length: 256 });
}

describe('encrypted invoice cursor', () => {
  it('round-trips across adapters sharing a key with a fresh nonce for each seal', async () => {
    const injectedKey = key();
    const issuer = createEncryptedInvoiceCursor(injectedKey);
    const reader = createEncryptedInvoiceCursor(injectedKey);

    const cursor = await issuer.seal({ ...scope, position });
    expect(cursor).toMatch(/^v1\.[A-Za-z0-9_-]+$/u);
    expect(Buffer.from(cursor.slice(3), 'base64url').includes(position)).toBe(false);
    await expect(reader.open({ ...scope, cursor })).resolves.toBe(position);
    await expect(issuer.seal({ ...scope, position })).resolves.not.toBe(cursor);
  });

  it.each([
    { organizationId: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b31' },
    { customerId: 'cus_other' },
    { liveMode: true },
  ])('rejects a cursor from another tenant, customer or Stripe mode', async (patch) => {
    const adapter = createEncryptedInvoiceCursor(key());
    const cursor = await adapter.seal({ ...scope, position });
    await expect(adapter.open({ ...scope, ...patch, cursor })).resolves.toBeNull();
  });

  it('refuses modified ciphertext, wrong keys and unknown versions', async () => {
    const adapter = createEncryptedInvoiceCursor(key());
    const wrongKey = createEncryptedInvoiceCursor(key());
    const cursor = await adapter.seal({ ...scope, position });
    const modified = Buffer.from(cursor.slice(3), 'base64url');
    const last = modified.readUInt8(modified.length - 1);
    modified.writeUInt8(last ^ 1, modified.length - 1);

    await expect(
      adapter.open({ ...scope, cursor: `v1.${modified.toString('base64url')}` }),
    ).resolves.toBeNull();
    await expect(wrongKey.open({ ...scope, cursor })).resolves.toBeNull();
    await expect(adapter.open({ ...scope, cursor: `v2.${cursor.slice(3)}` })).resolves.toBeNull();
  });

  it.each(['', 'v1.a=', 'v1.A', 'v1.AA', `v1.${'a'.repeat(1024)}`])(
    'rejects invalid encoding or size',
    async (cursor) => {
      await expect(
        createEncryptedInvoiceCursor(key()).open({ ...scope, cursor }),
      ).resolves.toBeNull();
    },
  );

  it('accepts the largest supported position, but rejects larger or empty ones', async () => {
    const adapter = createEncryptedInvoiceCursor(key());
    const largestPosition = `in_${'a'.repeat(252)}`;
    const cursor = await adapter.seal({ ...scope, position: largestPosition });
    await expect(adapter.open({ ...scope, cursor })).resolves.toBe(largestPosition);
    await expect(adapter.seal({ ...scope, position: `${largestPosition}b` })).rejects.toThrow(
      'Invalid invoice cursor position.',
    );
    await expect(adapter.seal({ ...scope, position: '' })).rejects.toThrow(
      'Invalid invoice cursor position.',
    );
  });

  it('requires a 256-bit injected symmetric key', () => {
    expect(() => createEncryptedInvoiceCursor(generateKeySync('aes', { length: 128 }))).toThrow(
      'An invoice cursor requires a 256-bit symmetric key.',
    );
  });
});
