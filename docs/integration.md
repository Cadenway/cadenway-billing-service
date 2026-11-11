# Domain and integration

[Documentation index](README.md) · [Repository instructions](../AGENTS.md)

**Status:** This page records the target design from repository instructions and skills. Its behavior has not been verified as implemented in this snapshot.

The tables and rules on this page are **target domain behavior**, not proof of a running service or an approved API. Source: `wp-billing-domain` ([Claude](../.claude/skills/wp-billing-domain/SKILL.md), [Codex](../.codex/skills/wp-billing-domain/SKILL.md)). The linked mockup and guides remain the source for product details; confirm ambiguous values before implementation.

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
- Card data never reaches Waypoint: only the provider reference is stored.

## Notes

Created when paid plans open. Open inconsistency in the mockup: the free plan is "10 members, 5 GB" on the website and "5 members, 2 GB" in the app; settle it before coding limits.

Everything above comes from the [repositories document](https://claude.ai/artifact/BPinmYxoF3mbK8w9BMB43N) and the
[integration guide](https://claude.ai/artifact/CpJHVCiFfF9j3KbHQ2S1Et). If the mockup disagrees with this guide, update the guide and its source skill for both assistants.

## Contract and delivery sequence

The `waypoint-api-contracts` repository owns HTTP and event specifications. Consumers use published `@waypoint/contracts` packages and `@waypoint/nest-messaging`; do not redefine payloads or connect to another service's database. Change contracts first, then the producing service, followed by gateways and listeners, and finally the webapp. Planned event names on this page must be checked against the actual published specification before use.

## References

[Interactive mockup](https://claude.ai/artifact/KYRM7AnsYLiBLBLKy8i4HE), [integration guide](https://claude.ai/artifact/CpJHVCiFfF9j3KbHQ2S1Et), and [repositories and packages](https://claude.ai/artifact/BPinmYxoF3mbK8w9BMB43N). Use [AGENTS.md](../AGENTS.md) as the local source for ownership and hard limits.
