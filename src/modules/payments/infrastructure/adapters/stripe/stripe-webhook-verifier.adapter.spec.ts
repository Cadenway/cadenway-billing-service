import { JSON_BODY_LIMIT_BYTES } from '@cadenway/nest-common';
import Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';

import { verifyStripeWebhook } from './stripe-webhook-verifier.adapter.js';

const receivedAt = Date.UTC(2026, 10, 21, 9);
const signedAt = receivedAt / 1_000;
const signedTimestamp = signedAt.toString();
const previousSecret = 'stripe-previous-fixture';
const rotatedSecret = 'stripe-rotated-fixture';
const original =
  '{\r\n  "id": "evt_atelier_nord", "object": "event", "data": {"name": "André"}\r\n}\r\n';

function sign(
  payload: string,
  secret: string = previousSecret,
  timestamp: number = signedAt,
): string {
  return Stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp });
}

describe('Stripe webhook verification', () => {
  it('verifies the original whitespace and UTF-8 bytes', () => {
    expect(
      verifyStripeWebhook(Buffer.from(original), sign(original), [previousSecret], receivedAt),
    ).toEqual({
      kind: 'verified',
      event: { id: 'evt_atelier_nord', object: 'event', data: { name: 'André' } },
    });
  });

  it.each([original.replaceAll('\r\n', '\n'), original.normalize('NFD'), `\uFEFF${original}`])(
    'refuses a byte-level change to the signed body',
    (modified) => {
      expect(
        verifyStripeWebhook(Buffer.from(modified), sign(original), [previousSecret], receivedAt),
      ).toEqual({ kind: 'invalid-signature' });
    },
  );

  it('refuses an invalid UTF-8 encoding of signed text', () => {
    const payload = '{"id":"evt_atelier_nord","name":"\uFFFD"}';
    const bytes = Buffer.from(payload);
    const invalidUtf8 = Buffer.concat([
      bytes.subarray(0, -5),
      Buffer.from([0xff]),
      bytes.subarray(-2),
    ]);

    expect(verifyStripeWebhook(invalidUtf8, sign(payload), [previousSecret], receivedAt)).toEqual({
      kind: 'invalid-event',
    });
  });

  it('accepts both active secrets when Stripe includes multiple v1 signatures during rotation', () => {
    const rotatedEntry = sign(original, rotatedSecret).replace(/^t=[0-9]+,/u, '');
    const header = `${sign(original)},${rotatedEntry},destination=fixture`;
    const body = Buffer.from(original);

    expect(verifyStripeWebhook(body, header, [previousSecret], receivedAt).kind).toBe('verified');
    expect(verifyStripeWebhook(body, header, [rotatedSecret], receivedAt).kind).toBe('verified');
    expect(
      verifyStripeWebhook(
        body,
        sign(original, rotatedSecret),
        [previousSecret, rotatedSecret],
        receivedAt,
      ).kind,
    ).toBe('verified');
  });

  it.each([signedAt - 301, signedAt + 301])(
    'refuses a valid signature outside the recency window',
    (timestamp) => {
      expect(
        verifyStripeWebhook(
          Buffer.from(original),
          sign(original, previousSecret, timestamp),
          [previousSecret],
          receivedAt,
        ),
      ).toEqual({ kind: 'invalid-signature' });
    },
  );

  it.each([
    undefined,
    '',
    sign(original).replace('v1=', 'v0='),
    `${sign(original)},t=${signedTimestamp}`,
    sign(original).replace(`t=${signedTimestamp}`, `t=${signedTimestamp}extra`),
    `${sign(original)},metadata=${'x'.repeat(4_096)}`,
  ])('refuses a missing or malformed signature header', (header) => {
    expect(
      verifyStripeWebhook(Buffer.from(original), header, [previousSecret], receivedAt),
    ).toEqual({ kind: 'invalid-signature' });
  });

  it('refuses multiple signature headers', () => {
    const header = sign(original);

    expect(
      verifyStripeWebhook(Buffer.from(original), [header, header], [previousSecret], receivedAt),
    ).toEqual({ kind: 'invalid-signature' });
  });

  it('accepts a signed body at the exact byte limit', () => {
    const padded = '{"id":"evt_atelier_nord"}'.padEnd(JSON_BODY_LIMIT_BYTES);

    expect(
      verifyStripeWebhook(Buffer.from(padded), sign(padded), [previousSecret], receivedAt),
    ).toEqual({ kind: 'verified', event: { id: 'evt_atelier_nord' } });
  });

  it('refuses an oversized payload before authentication or interpretation', () => {
    expect(
      verifyStripeWebhook(Buffer.alloc(JSON_BODY_LIMIT_BYTES + 1), undefined, [], receivedAt),
    ).toEqual({ kind: 'body-too-large' });
  });

  it('rejects an invalid signature before parsing the malformed JSON', () => {
    const malformedJson = '{"id":';
    const bytes = Buffer.from(malformedJson);

    expect(verifyStripeWebhook(bytes, sign(original), [previousSecret], receivedAt)).toEqual({
      kind: 'invalid-signature',
    });
    expect(verifyStripeWebhook(bytes, sign(malformedJson), [previousSecret], receivedAt)).toEqual({
      kind: 'invalid-event',
    });
  });

  it.each(['null', '[]'])('refuses signed JSON without an event object', (payload) => {
    expect(
      verifyStripeWebhook(Buffer.from(payload), sign(payload), [previousSecret], receivedAt),
    ).toEqual({ kind: 'invalid-event' });
  });

  it('returns a generic failure when the Stripe verifier is unavailable', () => {
    const verifier = Stripe.webhooks.signature;
    if (verifier === null) throw new Error('Stripe SDK signature test fixture is unavailable.');
    const verification = vi.spyOn(verifier, 'verifyHeader').mockImplementation(() => {
      throw new Error('Provider failure with request data.');
    });
    try {
      expect(
        verifyStripeWebhook(Buffer.from(original), sign(original), [previousSecret], receivedAt),
      ).toEqual({ kind: 'unavailable' });
    } finally {
      verification.mockRestore();
    }
  });
});
