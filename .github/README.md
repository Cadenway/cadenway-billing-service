# waypoint-billing-service

waypoint-billing-service owns what the organization pays for and consumes. NestJS, its own PostgreSQL database (one database and one user in the shared PostgreSQL of the VPS), events over NATS JetStream through `@waypoint/nest-messaging`, internal REST for the API gateway. Local port 3012.

|            |                                                                                                                                                 |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Data       | Plans, subscriptions, seats, invoices, payment method reference, usage counters (seats, storage, API calls, automation runs, guests, webhooks). |
| API        | Plan and plan change, seats, invoices as PDF, quotas and usage, alerts, CSV export.                                                             |
| Emits      | `subscription.changed`, `quota.threshold-reached (80 % then 90 %)`, `invoice.issued`                                                            |
| Listens to | `member.joined`, `member.removed`, `file.uploaded`, `file.deleted`, `automation.executed (counters)`                                            |
| External   | Payment provider (hosted payment page).                                                                                                         |
| Phase      | Extracted later, when needed                                                                                                                    |

Created when paid plans open. Open inconsistency in the mockup: the free plan is "10 members, 5 GB" on the website and "5 members, 2 GB" in the app; settle it before coding limits.

## Getting started

Requirements: Node.js LTS and pnpm (versions in `package.json`), and Docker.

1. Clone this repository next to the other Waypoint repositories, flat, in one folder.
2. To run it with the rest of Waypoint, start the stack from `waypoint-ops`; it builds the sibling
   folders, this one included (`core` profile; `full` adds every other service):

   ```bash
   cd ../waypoint-ops/compose
   docker compose -f compose.yaml -f compose.local.yaml --profile core up -d
   ```

3. To work on this repository alone:

   ```bash
   pnpm install
   pnpm start:dev              # http://localhost:3012
   ```

## Checks

Run the narrowest check first; CI runs them all on every pull request.

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test -- src/modules/<module>      # targeted
pnpm test:integration                    # PostgreSQL and NATS in Docker
pnpm test:coverage
pnpm build
docker compose -f compose.dev.yaml config -q
```

## Contributing

- [Contributing guide](CONTRIBUTING.md): branches, commits, pull requests, releases.
- [Code of conduct](CODE_OF_CONDUCT.md), [security policy](SECURITY.md), [getting help](SUPPORT.md).
- AI assistants follow [AGENTS.md](../AGENTS.md); Claude Code also reads [CLAUDE.md](../CLAUDE.md) and the
  tooling described in [.claude/README.md](../.claude/README.md).

## License

This repository is proprietary. See [LICENSE](../LICENSE) for the rights and restrictions that apply.

## References

- [Interactive mockup](https://claude.ai/artifact/KYRM7AnsYLiBLBLKy8i4HE): every screen, state and interaction.
- [Integration guide](https://claude.ai/artifact/CpJHVCiFfF9j3KbHQ2S1Et): tokens, data shapes, component names.
- [Repositories and packages](https://claude.ai/artifact/BPinmYxoF3mbK8w9BMB43N): what each repository owns, deployment.
