# Validation record

Date: **2026-10-03**. Local runtime: **Node 22.15.1 / npm 10.9.2**, macOS.

## Completed

| Check | Result |
|---|---|
| Dependency installation / audit | Lockfile generated; npm reported 0 known vulnerabilities at validation time |
| `npm run check` | Passed strict TypeScript check |
| `npm test` | 16 tests passed, 0 failed |
| `npm run build` | Compiled successfully |
| Three example previews | Rendered expected alert Markdown using the production renderer |
| Initialization smoke | Generated key/token/config files; secret permissions 0600; repeat initialization refused overwrite |
| `docker compose ... config --quiet` | Validated using temporary generated configuration |
| Compiled service smoke | `/healthz` and `/readyz` returned 200; SIGTERM exited cleanly with code 0 |
| Documentation links | All local Markdown links resolved |

The initialization/service smoke used an isolated temporary directory, removed after the test. It did not publish a Buzz message. Preview examples are synthetic. No production keys or alert payloads are included.

## Test coverage

`test/integration.test.ts` starts the actual proxy HTTP server and an independent HTTP fixture validating Nostr signatures, auth kind, request URL/method/body hash, nonce, message kind, channel tag, and author key. It checks:

- HTTP acceptance occurs before sending but after durable enqueue; restart reopens the outbox and delivers the stored event.
- Duplicate requests reuse the receipt; repeat relay sends keep the message ID but use fresh request-proof IDs.
- JSON/form/Bearer/native payload ingress, token rejection, input/output byte limits, content types, explicit Slack-thread rejection, and protected metrics.
- Explicit idempotency conflicts and queue-full 503 behavior.
- Relay 5xx/429/403/400 classification, Retry-After, malformed and mismatched acknowledgements, rejection, and no redirect credential forwarding.
- Expired leases can be reclaimed; stale leases cannot finalize a newer claim.
- Failed jobs remain visible after retention cleanup and can be requeued.
- Worker retries/permanent failures retain the original signed message.

`test/render.test.ts` checks legacy Alertmanager attachments, Block Kit fields/links, native firing/resolved alerts, entity/emphasis/code conversion, mentions/broadcast settings, plain text, rich text/list/quote/table output, unavailable controls, unknown blocks, excessive nesting, output limits, and unsafe image/button URL schemes.

## Still required before release

- A real Buzz relay and desktop/mobile rendering check, including identity admission and target channel permissions.
- Running Alertmanager/Grafana receiver tests and configuration validation with their own tools.
- A built/running Docker image: the local Docker daemon was unavailable. Compose syntax validation is not a container runtime test.
- Node 24/Linux CI execution, graceful termination under active load, disk-full/restore experiments, request streaming/timeout fault injection, and burst throughput measurements.
- Review of all operational/privacy/security assumptions and release licensing/publication metadata.

See `CODEX_HANDOFF.md` for the ordered acceptance criteria. Do not relabel this evidence as hosted end-to-end validation.
