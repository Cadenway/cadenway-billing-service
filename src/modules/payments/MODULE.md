# Payments

## Purpose

Authenticates Stripe payment deliveries. Stripe owns hosted checkout and card data.

## Public entry points

None.

## Owned tables

None.

## API

None. The app will register the incoming webhook after its contract is published.

## Events emitted

None.

## Events consumed

None.

## Invariants

- The original UTF-8 request bytes are bounded by the service JSON body limit.
- The signature header contains one recent timestamp and a valid Stripe `v1` signature for an
  active endpoint secret. Multiple signatures support rotation.
- The adapter authenticates the body before parsing JSON. It returns an object that downstream
  processing must validate before using the Stripe event ID and type.
- Verification failures report a category without including the body, header or signing secret.

## Transactions

None.

## Decisions

- The Stripe SDK verifies signatures locally. The webhook adapter receives the active endpoint
  secrets and uses the SDK's five-minute tolerance with the server clock.
