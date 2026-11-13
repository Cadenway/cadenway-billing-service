# Domain and integration

[Documentation index](README.md) · [Repository instructions](../AGENTS.md)

**Status:** This page records the target design from repository instructions and skills. Its behavior has not been verified as implemented in this snapshot.

The tables and rules on this page are **target domain behavior**, not proof of a running service or an approved API. Source: `cw-billing-domain` ([Claude](../.claude/skills/cw-billing-domain/SKILL.md), [Codex](../.codex/skills/cw-billing-domain/SKILL.md)). The linked mockup and guides remain the source for product details; confirm ambiguous values before implementation.

## What this service owns

What the organization pays for and consumes.

**Data**: Plans, subscriptions, seats, invoices, payment method reference, usage counters (seats, storage, API calls, automation runs, guests, webhooks).

**API**: Plan and plan change, seats, invoices as PDF, quotas and usage, alerts, CSV export.

**Events emitted**: `subscription.changed`, `quota.threshold-reached` (80% then 90%), `invoice.issued`.

**Events consumed**: `member.joined`, `member.removed`, `file.uploaded`, `file.deleted`, `automation.executed` (updates counters).

**External systems**: Payment provider (hosted payment page).

**Mockup screens**: Organisation › Facturation, Quotas et usage; the "Stockage presque plein" banner.

## Rules this service guards

- Gauges turn warning at 80 % and critical at 90 %.
- Downgrading is refused above the target plan limits (5 members or 20 GB in the mockup).
- Card data never reaches Cadenway: only the provider reference is stored.

## Payment provider

- The provider is Stripe, with Stripe-hosted pages for payment; the `stripe` SDK sits behind one
  port.
- A webhook is verified with `Stripe-Signature` over the **raw request body**, before any parsing.
- An invoice PDF is the file Stripe hosts: keep its `invoice_pdf` reference, never render a PDF here.
- The Stripe API version is the one pinned by the installed SDK; never set another `apiVersion`. An
  SDK major upgrade is reviewed as an API version change.
- The public route that receives Stripe webhooks is not in the contracts yet: it starts in
  cadenway-api-contracts.

## Notes

Created when paid plans open. Open inconsistency in the mockup: the free plan is "10 members, 5 GB" on the website and "5 members, 2 GB" in the app; settle it before coding limits.

Everything above comes from the [repositories document](https://claude.ai/artifact/BPinmYxoF3mbK8w9BMB43N) and the
[integration guide](https://claude.ai/artifact/CpJHVCiFfF9j3KbHQ2S1Et). If the mockup disagrees with this guide, update the guide and its source skill for both assistants.

## Engineering standards

These skills fix the engineering standards this service follows. They are target conventions, not proof of an implementation in this snapshot.

| Skill                                                                                                                                                | What it fixes                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cw-database-conventions` ([Claude](../.claude/skills/cw-database-conventions/SKILL.md), [Codex](../.codex/skills/cw-database-conventions/SKILL.md)) | Plural snake_case tables, `id` from `uuidv7()`, `organization_id` first in tenant indexes, `version`, `timestamptz` dates, `text` with `CHECK` for enumerations, forced row-level security, a pool of 5 connections, timeouts per role. |
| `cw-logging-and-tracing` ([Claude](../.claude/skills/cw-logging-and-tracing/SKILL.md), [Codex](../.codex/skills/cw-logging-and-tracing/SKILL.md))    | JSON logs with fixed fields and masking, W3C `traceparent` over HTTP and NATS, the ESM start-up flags, metrics per route and lag alerts, health and shutdown semantics.                                                                 |

## Contract and delivery sequence

The `cadenway-api-contracts` repository owns HTTP and event specifications. Consumers use published `@cadenway/contracts` packages and `@cadenway/nest-messaging`; do not redefine payloads or connect to another service's database. Change contracts first, then the producing service, followed by gateways and listeners, and finally the webapp. Planned event names on this page must be checked against the actual published specification before use.

## References

[Interactive mockup](https://claude.ai/artifact/KYRM7AnsYLiBLBLKy8i4HE), [integration guide](https://claude.ai/artifact/CpJHVCiFfF9j3KbHQ2S1Et), and [repositories and packages](https://claude.ai/artifact/BPinmYxoF3mbK8w9BMB43N). Use [AGENTS.md](../AGENTS.md) as the local source for ownership and hard limits.
