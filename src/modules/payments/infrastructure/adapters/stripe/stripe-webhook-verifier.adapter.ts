import { TextDecoder } from 'node:util';

import { JSON_BODY_LIMIT_BYTES } from '@cadenway/nest-common';
import Stripe from 'stripe';

const signatureLimit = 4_096;
const toleranceSeconds = Stripe.webhooks.DEFAULT_TOLERANCE;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

type Verification =
  | { readonly kind: 'verified'; readonly event: Readonly<Record<string, unknown>> }
  | { readonly kind: 'invalid-signature' | 'invalid-event' | 'body-too-large' | 'unavailable' };

/** Verifies an original Stripe delivery against any active endpoint secret before parsing JSON. */
export function verifyStripeWebhook(
  rawBody: Uint8Array,
  signature: string | readonly string[] | undefined,
  activeSecrets: readonly string[],
  receivedAt: number = Date.now(),
): Verification {
  if (rawBody.byteLength > JSON_BODY_LIMIT_BYTES) return { kind: 'body-too-large' };
  if (
    typeof signature !== 'string' ||
    signature.length > signatureLimit ||
    !isRecentSignature(signature, receivedAt)
  ) {
    return { kind: 'invalid-signature' };
  }

  let payload: string;
  try {
    // Strict decoding preserves valid UTF-8 byte-for-byte when the SDK hashes the text.
    payload = utf8.decode(rawBody);
  } catch {
    return { kind: 'invalid-event' };
  }

  const verifier = Stripe.webhooks.signature;
  if (verifier === null) return { kind: 'unavailable' };

  for (const secret of activeSecrets) {
    try {
      const authenticated = verifier.verifyHeader(
        payload,
        signature,
        secret,
        toleranceSeconds,
        undefined,
        receivedAt,
      );
      if (authenticated) return parseEvent(payload);
    } catch (error: unknown) {
      if (!(error instanceof Stripe.errors.StripeSignatureVerificationError)) {
        // An SDK error can carry the entire request. Keep only the failure category.
        return { kind: 'unavailable' };
      }
    }
  }
  return { kind: 'invalid-signature' };
}

function parseEvent(payload: string): Verification {
  try {
    const event: unknown = JSON.parse(payload);
    return isEventObject(event) ? { kind: 'verified', event } : { kind: 'invalid-event' };
  } catch {
    return { kind: 'invalid-event' };
  }
}

function isRecentSignature(signature: string, receivedAt: number): boolean {
  const timestampFields = signature.split(',').filter((field) => field.startsWith('t='));
  const [timestampField] = timestampFields;
  if (
    timestampFields.length !== 1 ||
    timestampField === undefined ||
    !/^t=[1-9][0-9]*$/u.test(timestampField)
  ) {
    return false;
  }

  const timestamp = Number(timestampField.slice(2));
  return (
    Number.isSafeInteger(timestamp) &&
    Math.abs(Math.floor(receivedAt / 1_000) - timestamp) <= toleranceSeconds
  );
}

function isEventObject(event: unknown): event is Readonly<Record<string, unknown>> {
  return typeof event === 'object' && event !== null && !Array.isArray(event);
}
