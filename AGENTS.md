# Slack to Buzz Proxy — agent guide

## READ FIRST

Read `docs/CODEX_HANDOFF.md` for current evidence, release milestones, and the next task. Read `docs/PROTOCOL_RESEARCH.md` before changing the Buzz wire format. Read `README.md` for the user contract.

## Intent Layer

This is the sole root context file. Before editing a subdirectory, read its `AGENTS.md` if one is added later. The current source is small enough to keep its contracts here; do not create a context file for every folder.

## Purpose and scope

Accept Slack incoming-webhook payloads from Prometheus Alertmanager, Grafana, and custom integrations; render useful Buzz messages; deliver signed kind-9 events to an explicitly configured community/channel. Also accept standard native Alertmanager/Grafana webhook payloads.

This is an independently implemented compatibility adapter. It is not a Slack server, a full Block Kit UI, an AI agent runtime, or an official Buzz integration. Interactive Slack callbacks, modal submission, chat.update, file migration, DMs, and Slack thread mapping remain out of scope for v0.1.

## Contracts and invariants

- HTTP `200 ok` means the complete signed event is durably committed to SQLite. It does not mean Buzz has delivered it. Never acknowledge before the commit.
- Retry the identical stored message event. Refresh only its NIP-98 request proof: exact URL, POST, body SHA-256, current timestamp, unique nonce.
- A successful relay response must acknowledge the same event ID and either accept it or identify a duplicate. HTTP 200 alone is insufficient.
- Never claim exactly-once end-to-end delivery. Body deduplication is time-bounded; sender retries outside that window can duplicate.
- The configured route fixes the Buzz channel; untrusted payloads must not select arbitrary destinations, keys, or relay URLs. Never forward auth across redirects.
- All secrets are operator supplied or locally generated into ignored files. No real credentials, relay dumps, tenant identifiers, alert content, webhook URLs, or private keys in commits/logs/test fixtures.
- Unsupported controls need visible fallbacks and compatibility warnings. Never describe Markdown conversion as native/full Block Kit support.
- Keep native alert annotations, firing/resolved state, labels, values, and useful URLs. Reject oversized output instead of silently truncating alerts.
- Retain failed deliveries, expose unhealthy status, and support explicit retry. Permanent rejection must not disappear as success.
- SQLite is for one deployment on a persistent local volume. Do not scale replicas until queue coordination, retention, and ownership are designed and tested.
- The real Buzz membership/channel policy is authoritative. A locally passing mock does not establish hosted Buzz compatibility or write access.

## Source map

| File | Responsibility |
|---|---|
| `src/render.ts` | Slack/Block Kit/attachment/native alert → Markdown |
| `src/server.ts` | HTTP parsing, route authentication, ingestion, probes/metrics |
| `src/buzz.ts` | Event signing, NIP-98 authentication, bounded relay HTTP |
| `src/store.ts` | Durable outbox, leases, deduplication, counters, retention |
| `src/worker.ts` | Retry policy and delivery lifecycle |
| `src/config.ts` | Validated configuration and secret loading |
| `src/cli.ts` | Init, preview, doctor, and failed-job retry |

## Validation

Use Node 22.15+ or Node 24; CI targets Node 22 and 24. `npm ci`, `npm run check`, `npm test`, `npm run build`. Tests must exercise the actual HTTP boundary, cryptographic signatures, ACK checks, retries, and SQLite restart behavior when changing those contracts. Do not replace them with tests that only reproduce implementation logic.

Record real relay, Docker, Alertmanager, and Grafana validation separately in `docs/CODEX_HANDOFF.md`. Keep the checked Buzz commit current. Never mark a milestone complete based solely on plans or mocks. Do not publish a repository/package/image or choose a copyright owner without the maintainer's direction.

## Contributor expectations

Use strict TypeScript, small explicit modules, bounded input and network operations, and stable error codes. Prefer Node built-ins; justify dependencies. Add a synthetic regression fixture when fixing a concrete compatibility gap. Match doc claims to tested behavior. This project has no chosen open-source license yet; finish the maintainer's license/ownership decision before public release.
