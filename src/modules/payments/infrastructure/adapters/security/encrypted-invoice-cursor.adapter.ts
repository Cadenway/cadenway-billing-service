import { createCipheriv, createDecipheriv, type KeyObject, randomBytes } from 'node:crypto';

import type { InvoiceCursor } from '../../../application/ports/outbound/security/invoices/invoice-cursor.port.js';

type CursorScope = Pick<
  Parameters<InvoiceCursor['open']>[0],
  'organizationId' | 'customerId' | 'liveMode'
>;

const algorithm = 'aes-256-gcm';
const version = 'v1';
const ivLength = 12;
const tagLength = 16;
const maxPositionLength = 255;
const positionOffset = ivLength + tagLength;
const maxCursorLength =
  version.length + 1 + Math.ceil(((positionOffset + maxPositionLength) * 4) / 3);
const encodedCursor = /^v1\.([A-Za-z0-9_-]+)$/u;

/** Encrypts Stripe pagination positions with authentication bound to the current tenant and mode. */
export function createEncryptedInvoiceCursor(key: KeyObject): InvoiceCursor {
  if (key.type !== 'secret' || key.symmetricKeySize !== 32) {
    throw new Error('An invoice cursor requires a 256-bit symmetric key.');
  }
  return {
    open(input): Promise<string | null> {
      if (input.cursor.length > maxCursorLength) return Promise.resolve(null);
      const encoded = encodedCursor.exec(input.cursor)?.[1];
      if (encoded === undefined) return Promise.resolve(null);
      const decoded = Buffer.from(encoded, 'base64url');
      if (
        decoded.toString('base64url') !== encoded ||
        decoded.length <= positionOffset ||
        decoded.length > positionOffset + maxPositionLength
      ) {
        return Promise.resolve(null);
      }

      try {
        const decipher = createDecipheriv(algorithm, key, decoded.subarray(0, ivLength), {
          authTagLength: tagLength,
        });
        decipher.setAAD(scopeData(input));
        decipher.setAuthTag(decoded.subarray(ivLength, positionOffset));
        const position = Buffer.concat([
          decipher.update(decoded.subarray(positionOffset)),
          decipher.final(),
        ]).toString('utf8');
        return Promise.resolve(position);
      } catch {
        return Promise.resolve(null);
      }
    },

    seal(input): Promise<string> {
      const position = Buffer.from(input.position, 'utf8');
      if (position.length === 0 || position.length > maxPositionLength) {
        return Promise.reject(new Error('Invalid invoice cursor position.'));
      }
      const iv = randomBytes(ivLength);
      const cipher = createCipheriv(algorithm, key, iv, { authTagLength: tagLength });
      cipher.setAAD(scopeData(input));
      const data = Buffer.concat([cipher.update(position), cipher.final()]);
      return Promise.resolve(
        `${version}.${Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url')}`,
      );
    },
  };
}

function scopeData(scope: CursorScope): Buffer {
  return Buffer.from(
    JSON.stringify([
      'billing-invoice-cursor',
      version,
      scope.organizationId,
      scope.customerId,
      scope.liveMode,
    ]),
  );
}
