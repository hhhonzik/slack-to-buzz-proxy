# Slack to Buzz Proxy

Send Prometheus Alertmanager, Grafana, and custom Slack webhook notifications to a Buzz community.

**Status: tested prototype; no stable release yet.** The source repository is [hhhonzik/slack-to-buzz-proxy](https://github.com/hhhonzik/slack-to-buzz-proxy). No live Buzz community has been used for validation yet. The release plan is in [docs/CODEX_HANDOFF.md](docs/CODEX_HANDOFF.md). The open-source license is still to be selected; package publication remains disabled.

```text
Alertmanager / Grafana / custom Slack webhook
    → authenticated HTTP endpoint
    → Slack / Block Kit / native alert → Markdown
    → persistent SQLite outbox
    → signed Nostr kind-9 message + NIP-98 HTTP auth
    → your Buzz relay POST /events → channel
```

## What works

- Slack JSON incoming-webhook payloads and legacy `payload=<JSON>` form encoding.
- Legacy attachments used by Alertmanager/Grafana: title, severity marker, text, fields, footer, timestamp, image, and URL actions.
- Block Kit content translation: headers, sections, fields, dividers, context, images, URL buttons, rich text, lists, quotes, code, tables, Markdown, and video links/thumbnails.
- Native Alertmanager/Grafana webhook objects: firing/resolved alerts, annotations, labels, values, source/dashboard/panel/silence URLs, timestamps, and truncation notices.
- Fixed per-webhook channel routing, optional Slack-user → Buzz-public-key mappings, and opt-in channel broadcast.
- Durable queue, retry/backoff, duplicate-event acknowledgements, body deduplication, explicit idempotency keys, metrics, and failed-delivery inspection/retry.

**Block Kit compatibility is a content conversion, not a native Block Kit interface.** Buzz renders Markdown. Columns, card colors, spacing, and interactive widgets cannot be reproduced exactly. URL buttons become links. Callback buttons, selectors, and unsupported/new blocks produce visible fallbacks. Slack private files need Slack authorization and cannot be migrated by this service. See [the compatibility matrix](docs/COMPATIBILITY.md).

## Quick start

Requires Node 22.15+ (Node 24 recommended). Node 22 may display its built-in SQLite experimental warning.

```sh
npm ci
npm run init
```

Initialization creates ignored local configuration, a random bot key, and random webhook/admin tokens. It prints only the public identity. It will not overwrite existing files.

1. Set the **actual community relay origin** in `.env` (`BUZZ_RELAY_URL`). Use the URL from your Buzz community, not the `buzz.xyz` marketing site. HTTPS/WSS and HTTP/WS origins are normalized automatically.
2. Admit the generated bot public key to the community and grant access to the destination stream channel. The exact admission flow depends on the relay's membership policy. An existing managed-agent identity may require a NIP-OA owner attestation; supply `BUZZ_AUTH_TAG_FILE` if applicable. Do not use your personal key as the deployment default.
3. Put the Buzz channel UUID into `routes.json`. With Buzz's CLI and that same admitted identity, `buzz channels list` discovers channels and `buzz channels join --channel <uuid>` requests membership. The CLI's key environment is `BUZZ_PRIVATE_KEY`, while this proxy additionally supports `BUZZ_PRIVATE_KEY_FILE`. Relay admission is a separate prerequisite to channel joining.
4. Run `npm run doctor` to check authenticated read access and list visible channels. This does **not** verify posting permission.
5. Start the service:

```sh
npm run build
npm start
```

Your webhook is `https://YOUR-PROXY/hooks/alerts/<contents-of-secrets/webhook.token>`. `/services/alerts/<token>` is an equivalent alias. The shorter `/hooks/alerts` accepts `Authorization: Bearer <token>` for senders supporting custom authorization headers.

Test using `examples/block-kit.json` or your alert sender's Test action, then confirm both the delivered counter and the message in Buzz. No message is sent by `init`, `preview`, or `doctor`.

## Docker Compose

After initialization and configuration:

```sh
docker compose up --build -d
docker compose logs -f proxy
```

Compose mounts `data/` persistently and reads secrets from `secrets/`. Initialization records the host user/group in `.env` so the non-root container can read mode-600 secrets and write the data directory on Linux/macOS. Adjust `PROXY_UID` / `PROXY_GID` and file ownership if deploying on another host. If adding `BUZZ_AUTH_TAG_FILE` or more route-token files, mount those secrets explicitly in Compose.

The default host binding is `127.0.0.1:8080`. Put an HTTPS reverse proxy in front of it. Containers on the same Compose network can use `http://proxy:8080`; `localhost` inside Grafana or Alertmanager refers to that sender's container. Configure access-log redaction for `/hooks/*` and `/services/*` because path tokens are credentials. `/metrics` and `/status` require the separate admin bearer token.

Docker configuration is included; local container execution has not been tested because the Docker engine was unavailable. Do not run multiple replicas against independent SQLite files. Keep the database on a persistent local filesystem, not an ephemeral container layer or shared network filesystem.

## Prometheus Alertmanager

Keep your existing `slack_configs`, replace `api_url` with the proxy webhook URL, and set `send_resolved: true`. [examples/alertmanager.yml](examples/alertmanager.yml) is a complete minimal configuration. `channel` may remain `#alerts`; the proxy's route controls the Buzz destination.

Alternatively use standard `webhook_configs` and the native renderer: [examples/alertmanager-native.yml](examples/alertmanager-native.yml). Alertmanager does not expand environment variables in these files. Use `api_url_file` or `credentials_file` to mount secrets.

## Grafana

In **Alerting → Contact points**, add a **Slack** contact point. Enter the proxy URL in **Webhook URL**, use `#alerts` as the recipient if required, and keep resolved notifications enabled. Use **Test**, then verify the result in Buzz and attach the contact point to a notification policy.

[examples/grafana-provisioning.yml](examples/grafana-provisioning.yml) provisions the same contact point using `BUZZ_WEBHOOK_URL` in Grafana's environment. A **Webhook** contact point can also POST the default native alert payload to `/hooks/alerts` with Bearer authorization. Custom native payload templates must preserve the normal `alerts` and `status` fields. Grafana's built-in Slack integration does not offer arbitrary custom Block Kit layouts; custom webhook senders can supply `blocks` directly.

## Preview without sending

```sh
npm run preview -- examples/block-kit.json
npm run preview -- examples/slack-alertmanager.json
npm run preview -- examples/grafana-webhook.json
```

The preview is the actual rendered Markdown. Warnings on stderr describe lossy conversions. The same warning codes appear in `X-Buzz-Proxy-Warnings` and structured server logs.

## Routing and mentions

Each route needs a unique name, destination channel UUID, and `tokenEnv` or `tokenFile`. With `tokenEnv: "ALERTS_WEBHOOK_TOKEN"`, set either that variable or `ALERTS_WEBHOOK_TOKEN_FILE`. See [examples/routes.example.json](examples/routes.example.json).

Map Slack users with `"users": { "U123": "<64-hex Buzz public key>" }`. This adds Nostr `p` tags and a `nostr:npub…` reference. Unmapped users and user groups remain readable text. `allowBroadcast` defaults to false; enabling it converts Slack `here`, `channel`, and `everyone` into Buzz's channel broadcast tag. Slack's active-user-only `here` semantics cannot be preserved.

All messages use the configured bot identity/profile. Slack `username`, `icon_url`, and `icon_emoji` do not change the Buzz author. Set that profile through Buzz. `thread_ts` is rejected explicitly because a Slack timestamp is not a Buzz event ID.

## Delivery and operations

`200 ok` means the event was committed to the outbox. Actual delivery is asynchronous. The response includes `X-Buzz-Proxy-Event-Id` and `X-Buzz-Proxy-Delivery: queued|duplicate`. A full queue or failed persistence returns 503; invalid input returns 4xx before anything is enqueued.

The worker sends at most one request at a time. It retries network errors, invalid/mismatched acknowledgements, 408/425/429, 5xx, and 401/403 (so corrected membership can recover). Retry delay grows to about five minutes, respects `Retry-After` up to 24 hours, and gives authentication failures at least one minute. Other rejections enter the failed queue. Retryable delivery expires after seven days. Stored message signatures remain unchanged across retries; HTTP auth signatures are fresh.

Identical JSON payloads on the same route are suppressed for `DEDUP_SECONDS` (default 60). If legitimate reminders repeat within that period, set it to 0 or below the sender's repeat interval. JSON property order affects this automatic deduplication. Optional `Idempotency-Key` headers persist for seven days; changing a payload under the same key returns 409. This is **at-least-once delivery with bounded deduplication**, not an end-to-end exactly-once guarantee.

- `/healthz`: process liveness.
- `/readyz`: local queue health; 503 if failed jobs exist, the queue is full, or the oldest pending job exceeds five minutes. Does not proactively test Buzz connectivity or membership.
- `/metrics`: authenticated Prometheus queue depths, oldest pending age, and persistent counters.
- `/status`: authenticated metadata for the first 100 unfinished jobs; excludes message bodies and credentials.
- `npm run queue`: inspect the local outbox.
- `npm run queue -- retry EVENT_ID`: retry one permanently failed job after fixing the underlying problem. In Compose use `docker compose exec proxy node dist/cli.js queue retry EVENT_ID`.

Delivered message bodies are cleared; their deduplication receipts are retained for `RETENTION_DAYS` (default 7). Pending and failed jobs contain alert text and need protected storage. Failed jobs are retained indefinitely until operationally resolved; they count toward `MAX_QUEUED`, preventing unbounded failed-job growth. SQLite can retain freed pages; perform backups/maintenance with SQLite-aware tooling. Route changes and bot key rotation do not silently retarget queued events: mismatched identities/destinations fail and require reconciliation.

Scrape `/metrics` with the admin token and use [examples/prometheus-rules.yml](examples/prometheus-rules.yml). Send proxy-health alerts through an independent notification channel so a Buzz outage can still reach you.

## Configuration reference

| Variable | Default / purpose |
|---|---|
| `BUZZ_RELAY_URL` | Required community relay origin |
| `BUZZ_PRIVATE_KEY` / `_FILE` | Required dedicated bot secret, hex or nsec |
| `BUZZ_AUTH_TAG` / `_FILE` | Optional NIP-OA JSON auth tag |
| `ROUTES_FILE` | `routes.json` |
| `ADMIN_TOKEN` / `_FILE` | Optional; metrics/status disabled without it |
| `HOST`, `PORT` | `0.0.0.0`, `8080` |
| `DATABASE_PATH` | `data/outbox.sqlite` |
| `DEDUP_SECONDS` | `60`, range 0–3600 |
| `MAX_QUEUED` | `10000` pending + failed jobs |
| `MAX_BODY_BYTES` | `1048576`; rendered message limit is 60 KiB UTF-8 |
| `BUZZ_TIMEOUT_MS` | `10000` |
| `RETENTION_DAYS` | `7` delivered-receipt retention |

## Development

```sh
npm ci
npm run check
npm test
npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [AGENTS.md](AGENTS.md), [the research notes](docs/PROTOCOL_RESEARCH.md), and [the Codex handoff](docs/CODEX_HANDOFF.md). The local tests cover the actual HTTP service and a protocol-verifying fake relay; they do not replace real Buzz/Alertmanager/Grafana integration tests.
