# Plans

## Purpose

Defines the capacity included in Billing plans. The current domain defines the Free plan limits.
Usage owns the measurement of quota consumption.

## Public entry points

None.

## Owned tables

None.

## API

None. Billing routes require a published contract.

## Events emitted

None.

## Events consumed

None.

## Invariants

- The Free plan includes five billed seats and 2,000,000,000 bytes of storage.
- Guest memberships are tracked separately from billed seats.

## Transactions

None. The limits are immutable domain data.

## Decisions

- The confirmed P5 Free plan limits match Organisation › Facturation in the application mockup.
- Storage limits use decimal bytes, with one gigabyte equal to 1,000,000,000 bytes.
