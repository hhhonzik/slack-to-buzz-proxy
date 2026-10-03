# Codex handoff and open-source release plan

## Objective

Ship a small, independently maintained proxy that accepts Slack-style notifications from Prometheus Alertmanager/Grafana and reliably posts useful messages to Buzz.xyz communities, including practical Block Kit content conversion. Prepare it for an open-source repository with honest compatibility claims and reproducible integration evidence.

**Maintainer direction:** the user intends to open-source this project and wants Codex to take over the remaining work. The maintainer has authorized the public repository `hhhonzik/slack-to-buzz-proxy`. No deployment, package publication, bot community, or open-source license has been configured. Continue from this implementation; do not restart the research or substitute a design-only answer.

## Current state — 2026-10-03

| Area | Evidence / state |
|---|---|
| Research | Official Slack/Prometheus/Grafana docs plus pinned Buzz source commit; see `PROTOCOL_RESEARCH.md` |
| Implementation | Strict TypeScript, Node HTTP, `nostr-tools`, built-in SQLite |
| Ingress | Fixed-channel routes, secret URL/Bearer auth, JSON/form Slack payloads, native alert payloads |
| Rendering | Attachments and common Block Kit converted to Markdown, explicit unsupported fallbacks |
| Delivery | Signed kind-9 events, fresh NIP-98 proofs, durable outbox, leases, retries, ACK validation |
| Operations | Init/preview/doctor/queue CLI, readiness, authenticated metrics/status, example alert rules |
| Local verification | Type check, build, and 16 automated tests passed on Node 22.15.1; tests use a protocol-verifying fake relay |
| Packaging | Dockerfile, Compose, example sender configs, CI skeleton, contributor/agent docs; Compose configuration validated |
| Real Buzz | **Not tested**; no relay credentials/channel supplied |
| Real senders | **Not tested** with running Alertmanager/Grafana; current fixtures are synthetic |
| Docker | **Not run locally**; CLI installed but daemon unavailable |
| Repository | Public development repository: `hhhonzik/slack-to-buzz-proxy`; no stable release or chosen license yet |

The source directory is already the portable project. `node_modules`/`dist` are generated. No outside upstream checkout or absolute local path is required to build it.

The detailed baseline evidence is in [`VALIDATION.md`](VALIDATION.md), including CLI initialization, compiled-service liveness/readiness, and graceful shutdown smoke checks.

## First session for the next Codex task

1. Read `AGENTS.md`, this file, `README.md`, and `docs/PROTOCOL_RESEARCH.md`.
2. Run `npm ci`, `npm run check`, `npm test`, `npm run build`, and all three previews. Verify the documented test count and update this evidence record if changed.
3. Inspect the current implementation for concrete deviations from its stated delivery/compatibility contract. Fix regression-tested defects before widening scope.
4. Start **M1** below. Ask for the community relay origin, destination channel UUID, and how the dedicated bot identity will be admitted. Secrets should be configured in local/host secret files, not pasted into task text or committed.
5. In parallel with missing credentials, finish work in M2/M3 that needs only synthetic local services. Do not claim hosted compatibility from those tests.
6. Keep one `docs/VALIDATION.md` evidence log containing versions, exact reproducible steps, observed outcomes, and remaining gaps; no sensitive payloads. Update this handoff at each completed milestone.

## Decisions already made

- **Delivery transport:** Buzz's existing signed HTTP event bridge, not browser automation, Slack OAuth, or a Buzz CLI subprocess.
- **Formatting:** useful content preservation into Markdown. Full native Block Kit parity requires Buzz client work and is not a promise of this proxy.
- **Initial runtime:** Node/TypeScript, Docker-ready, one deployment with SQLite on a persistent volume.
- **Acceptance semantics:** acknowledge after durable enqueue. Operators must monitor downstream delivery; do not switch to silent best-effort fire-and-forget.
- **Destination authority:** server-side route configuration. Incoming `channel` cannot retarget the bot.
- **Retries:** same message event ID/signature, new NIP-98 auth on each attempt; backoff and no auth-bearing redirects.
- **Scope:** notification bridge. AI triage, Slack app OAuth, bidirectional sync, DMs, interactive callback execution, and Slack timestamp-to-Buzz thread mappings are separate future features.

## M1 — Prove the Buzz integration (release blocker)

**Deliverable:** a documented, reproducible alert arriving in an actual supported Buzz relay and client, with a dedicated admitted bot identity.

Tasks:

- Confirm target relay version/origin and whether it permits a normal admitted key, requires NIP-OA delegation, or enforces additional NIP-FI identity assertions. Do not disable the relay's policy to make the demo pass.
- Initialize/import a dedicated key; establish community membership and stream-channel access. Validate public/private channel policy and denied-membership behavior. Document the shortest onboarding path for the supported deployment.
- Exercise `/query` through `doctor`, then submit plain text, the supplied Block Kit fixture, and the legacy Alertmanager attachment fixture through the proxy. Record the relay ACK and visually inspect Buzz.
- Check Unicode, links, code, tables, images, mapped user mentions, and explicit broadcast opt-in on a real client. Document client/version differences.
- Force a relay outage and restart the proxy after acceptance. Restore the relay and verify the queued signed event is delivered once at that event ID. Test timeout-after-accept/duplicate-ACK recovery.
- Verify 401/403 recovery after correcting access, and permanent rejection visibility/requeue.

Acceptance:

- Redacted evidence includes the exact versions and reproducible commands, not credentials.
- A denied identity cannot post; the correct identity can post only to authorized configured channels.
- The rendering matrix matches observed Buzz output. Fix deviations or explicitly narrow claims.
- No unsupported identity mode is advertised as supported. If NIP-FI is required, scope a separate credential acquisition/refresh design before implementing it.

Touchpoints: `src/buzz.ts`, `src/config.ts`, `src/cli.ts`, `src/render.ts`, `docs/PROTOCOL_RESEARCH.md`.

## M2 — Prove Prometheus and Grafana compatibility (release blocker)

**Deliverable:** repeatable end-to-end tests using pinned sender versions, plus tested configuration examples.

Tasks:

- Add an integration environment with Alertmanager, Grafana, the proxy, and either a real test Buzz relay or a protocol-checking relay fixture. Keep real-relay validation distinguishable from the fixture.
- Validate `examples/alertmanager.yml` with `amtool check-config`. Fire and resolve alerts through the Slack receiver; test grouped alerts, annotations, a URL action, and API URL file secrets.
- Exercise native `webhook_configs`, including Bearer credentials, multiple alerts, and `truncatedAlerts`.
- Provision Grafana's Slack contact point from the supplied file, set the environment URL, route a real firing/resolved rule, and test its UI notification. Verify the schema uses `settings.url` and secret expansion as the current docs require.
- Exercise Grafana's default native webhook, including dashboard/panel/silence URLs and values. If a specific Grafana version validates webhook hostnames, use the native contact point and document that restriction.
- Preserve sanitized sender-shaped fixtures from these tests. Add exact regression assertions for required visible alert information.

Acceptance:

- Both senders produce firing and resolved notifications visible in Buzz through the Slack-compatible endpoint.
- Native webhook behavior is tested separately; full arbitrary custom-payload templates are not claimed.
- Examples load without manual undocumented schema edits. Credentials are read from local secrets or supported provisioning environment variables.

Touchpoints: `examples/`, `test/`, `src/render.ts`, `README.md`.

## M3 — Harden the initial deployment (release blocker)

**Deliverable:** a tested single-instance container deployment and an operations runbook.

Tasks:

- Build/run the image on Linux and test Compose secret-file ownership using the recorded `PROXY_UID`/`PROXY_GID`, read-only root filesystem, and writable persistent `data/` bind mount. Revisit portability if Windows support is intended.
- Verify graceful termination, lease expiry after a killed worker, restart with pending events, disk-full/write failure, and database backup/restore with WAL present. Add explicit schema versioning/migration policy before release.
- Test request timeout, malformed/chunked oversized bodies, queue-full backpressure, idempotency TTL/conflicts, and route/token/key rotation. Ensure stale workers cannot finalize another lease.
- Exercise large grouped alerts near the byte limit and document splitting/grouping recommendations. Automatic splitting is a future feature; do not silently truncate.
- Benchmark alert-burst throughput/queue growth with the current one-at-a-time worker and establish supported operating limits. Avoid adding multi-replica claims based only on SQLite leases.
- Verify delivered body clearing, receipt retention, failed-job retention/retry, metrics scrape auth, and independent delivery-failure alert routing.
- Check logs and reverse-proxy examples for secret-bearing path/body leakage. Add a tested TLS ingress example if desired.

Acceptance:

- A documented burst stays within declared resource limits and survives restart without losing accepted jobs.
- A failure to persist never returns 200. A failed relay ACK never increments delivered.
- `/readyz`, metrics, and the retry command give an operator a complete recovery path.
- Container and runtime checks run in CI. Every unsupported topology is stated explicitly.

Touchpoints: `src/store.ts`, `src/worker.ts`, `src/server.ts`, `Dockerfile`, `compose.yaml`, `.github/workflows/ci.yml`.

## M4 — Prepare the public repository and first release

**Repository and project name:** `hhhonzik/slack-to-buzz-proxy`, authorized by the maintainer. **Remaining maintainer decisions:** open-source license/copyright attribution, preferred image registry, and supported runtime/sender/relay versions. Apache-2.0 or MIT are reasonable candidates; no choice has been applied yet. The current package is `UNLICENSED` and `private:true` to prevent accidental package publication.

Tasks:

- Add the chosen license and notices; review direct/transitive dependency licenses. No Buzz source was vendored into this implementation; keep attribution/source links accurate.
- The public development repository is `hhhonzik/slack-to-buzz-proxy`. Keep its contents limited to this project, excluding the surrounding task workspace and research checkout.
- Add a changelog, issue/PR templates, support policy, and private security-reporting channel. Pin CI actions to verified commit SHAs and dependencies/base image strategy to the agreed support policy.
- Add release build, vulnerability/license checks, SBOM, and image provenance/signing as appropriate. Keep image upload/tag creation gated by the intended release process.
- Attach the M1–M3 validation evidence and tested compatibility matrix to a v0.1.0 release candidate. Write a short migration guide for changing a Slack webhook URL to this proxy.
- Publish a stable release only after license metadata and required integration evidence are complete. Do not infer authorization to upload secrets, create paid services, or publish packages merely from a local test pass.

Acceptance:

- A new contributor can clone, test, preview, initialize, and deploy from the public README without the original task context.
- The repo/archive/image contains no local secrets, alert data, databases, node_modules, or private research artifacts.
- Claims consistently say “Slack webhook / Block Kit content compatibility” and identify unsupported interactive behavior.

## Follow-on backlog (not required for v0.1)

Prioritize from real issues: richer/new Slack block conversion, optional oversize message splitting with atomic enqueue, safe custom emoji mapping, Grafana webhook HMAC verification, richer profile/onboarding helper, schema migrations, Kubernetes chart, shared-database queue for HA, Slack-thread mapping, and explicit interactions with an authenticated callback service. Do not add bidirectional Slack synchronization without a separate product decision.

## Ready-to-paste Codex prompt

> Continue the Slack to Buzz Proxy project in this directory. Read AGENTS.md, docs/CODEX_HANDOFF.md, README.md, and docs/PROTOCOL_RESEARCH.md first. Preserve the existing implementation and its durable delivery contract. Re-run the baseline checks, then work through M1–M3 in dependency order, doing independent local work while waiting for missing relay details. Add or update docs/VALIDATION.md with actual evidence and keep unsupported deployment modes explicit. Prepare M4's repository/release assets, using the existing hhhonzik/slack-to-buzz-proxy repository; obtain the license/copyright decision before publishing a release. Do not claim native/full Block Kit compatibility, hosted Buzz verification, or exactly-once delivery based on mocks. Keep all credentials and real alert data out of commits, logs, and artifacts.
