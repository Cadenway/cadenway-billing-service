# Architecture and ownership

[Documentation index](README.md) · [Repository instructions](../AGENTS.md)

## Status

At the time this documentation was written, this checkout has no `package.json`, application source tree, or GitHub workflow files. The target architecture, scripts, and workflows in this guide must be created and verified during bootstrap.

The following architecture is the target recorded in [AGENTS.md](../AGENTS.md). Paths and integrations are design boundaries, not evidence that files or services already exist.

## Purpose and target structure

waypoint-billing-service owns what the organization pays for and consumes. NestJS, its own PostgreSQL database (one database and one user in the shared PostgreSQL of the VPS), events over NATS JetStream through `@waypoint/nest-messaging`, internal REST for the API gateway. Local port 3012.

|            |                                                                                                                                                 |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Data       | Plans, subscriptions, seats, invoices, payment method reference, usage counters (seats, storage, API calls, automation runs, guests, webhooks). |
| API        | Plan and plan change, seats, invoices as PDF, quotas and usage, alerts, CSV export.                                                             |
| Emits      | `subscription.changed`, `quota.threshold-reached` (80% then 90%), `invoice.issued`                                                            |
| Listens to | `member.joined`, `member.removed`, `file.uploaded`, `file.deleted`, `automation.executed` (updates counters)                                            |
| External   | Payment provider (hosted payment page).                                                                                                         |
| Phase      | Extracted later, when needed                                                                                                                    |

Created when paid plans open. Open inconsistency in the mockup: the free plan is "10 members, 5 GB" on the website and "5 members, 2 GB" in the app; settle it before coding limits.

## Architectural ownership

- Business code lives in modules under `src/modules/<module>/`, each with `domain/`, `application/`, `infrastructure/`, `api/` and a `MODULE.md`.
- Cross-cutting plumbing (config, logging, tracing, errors, auth guards, messaging) comes from the waypoint-service-kit packages (`@waypoint/nest-common`, `@waypoint/nest-messaging`, `@waypoint/nest-testing`), never re-implemented here.
- The domain is pure; use cases own transactions; controllers and handlers translate.
- Rendering of anything user-facing belongs to the webapp; this service returns data and stable error codes.

## Boundaries

- No access to another service's database or internal code; cross-service needs use `@waypoint/contracts` routes or events.
- NATS only through `@waypoint/nest-messaging`; config, logs, errors, health and auth guards through `@waypoint/nest-common`.
- Routes and event payloads come from the installed `@waypoint/contracts`; never redefine them locally.
- The service is internal: no Traefik label, no public route; the API gateway is its only HTTP caller.
- No sibling sources imported, no `file:` or `link:` dependency on a sibling.

## Cross-repository changes

Each checkout owns its implementation and release. Use published `@waypoint/*` packages instead of sibling source imports or local dependency links. For contract changes, make the contract and generated package available first, then update the producing service, gateways and listeners, and finally the webapp. Each step should remain deployable independently.
