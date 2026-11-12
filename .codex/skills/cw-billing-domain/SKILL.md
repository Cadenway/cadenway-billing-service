---
name: cw-billing-domain
description: "The data, rules, events and screens cadenway-billing-service owns, taken from the mockup, the integration guide and the repositories document. Load it before naming, modeling or testing anything in this service."
---

# billing-service domain

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

## Notes

Created when paid plans open. Open inconsistency in the mockup: the free plan is "10 members, 5 GB" on the website and "5 members, 2 GB" in the app; settle it before coding limits.

Everything above comes from the [repositories document](https://claude.ai/artifact/BPinmYxoF3mbK8w9BMB43N) and the
[integration guide](https://claude.ai/artifact/CpJHVCiFfF9j3KbHQ2S1Et). When the mockup and this skill disagree, the mockup wins and
this skill is corrected in the same change.
