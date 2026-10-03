# Protocol findings: Slack → Buzz

Research date: **2026-10-03**. Buzz source inspected at commit [`33f54de2dd27a8f6bce0d359183f5ebe5f2fa9ba`](https://github.com/block/buzz/tree/33f54de2dd27a8f6bce0d359183f5ebe5f2fa9ba). The read-only upstream checkout used during development is outside this deliverable; nothing here depends on that checkout.

## Which Buzz?

The target is Block's open-source workspace at **buzz.xyz**, backed by the [block/buzz repository](https://github.com/block/buzz). Search results for Buzzio, Buzz.ai, and ChainGPT Buzz refer to other products and must not be used as API evidence for this integration.

A Buzz community is selected by its relay URL. The marketing site is not a universal messaging API. Identities are Nostr public/private keypairs, messages are signed events, and relay/channel membership controls access. [Official Buzz support](https://block.github.io/buzz/support.html).

## Comparison

| Concern | Slack | Buzz / bridge decision |
|---|---|---|
| Incoming message | HTTP webhook JSON | Proxy accepts Slack-shaped HTTP and creates a Buzz event |
| Authentication | Secret webhook URL | Proxy route token at ingress; bot key + NIP-98 toward Buzz |
| Workspace | Slack workspace configuration | Exact community relay origin |
| Channel | Incoming webhook's configured channel | Route fixes a Buzz channel UUID |
| Identity | Slack app/bot | Separate admitted Buzz public key and profile |
| Content | Text, mrkdwn, attachments, Block Kit | Markdown body on a kind-9 stream message |
| Buttons | URL or interactive callback | URL → link; callbacks → visible unavailable marker |
| Threads | Slack `thread_ts` | Buzz event references; translation needs persistent mapping, omitted in v0.1 |
| Delivery | Slack webhook acknowledgement | Proxy acknowledges durable acceptance; worker checks relay ACK |

Slack incoming webhooks accept JSON and layout blocks, with plain `ok` success responses. These webhooks are not a general Slack Web API replacement. [Official webhook documentation](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/).

## Verified Buzz wire contract

1. A channel message uses **kind 9** and an `h` tag containing the channel UUID. Content is limited to 64 KiB by the SDK; this implementation uses a conservative 60 KiB rendered limit. Mentions use `p` tags, and channel-wide notification uses `broadcast=1`. [Pinned message builder](https://github.com/block/buzz/blob/33f54de2dd27a8f6bce0d359183f5ebe5f2fa9ba/crates/buzz-sdk/src/builders.rs#L231).
2. Signed events can be submitted as the raw JSON body of **POST `/events`**. Its HTTP authentication is a separate signed kind-27235 NIP-98 event in `Authorization: Nostr <base64-json>`. [Pinned relay handler](https://github.com/block/buzz/blob/33f54de2dd27a8f6bce0d359183f5ebe5f2fa9ba/crates/buzz-relay/src/api/bridge.rs#L898).
3. The request proof binds the **exact URL**, HTTP method, and SHA-256 of the serialized request body. A fresh nonce prevents replay rejection when retrying within the same second. The stored message event remains unchanged. [Pinned CLI signing implementation](https://github.com/block/buzz/blob/33f54de2dd27a8f6bce0d359183f5ebe5f2fa9ba/crates/buzz-cli/src/client.rs#L78) and [NIP-98 specification](https://github.com/nostr-protocol/nips/blob/master/98.md).
4. The response includes `event_id`, `accepted`, and `message`. The current relay returns `accepted: true` with `message: "duplicate:"` for an already stored message; the bridge also accepts a same-ID `accepted: false` duplicate acknowledgement defensively. Other false acknowledgements are failures. [Pinned ingest duplicate handling](https://github.com/block/buzz/blob/33f54de2dd27a8f6bce0d359183f5ebe5f2fa9ba/crates/buzz-relay/src/handlers/ingest.rs#L3457).
5. POST `/query` accepts an array of Nostr filters and supports authenticated channel discovery (kind 39000 metadata). It does not prove write access. [Pinned CLI channel discovery](https://github.com/block/buzz/blob/33f54de2dd27a8f6bce0d359183f5ebe5f2fa9ba/crates/buzz-cli/src/commands/channels.rs).
6. The desktop Markdown pipeline includes GFM and line-break handling. No Slack Block Kit renderer was found in the examined message/UI code. This supports a content-translation architecture; pixel/layout equivalence is not established. [Pinned Markdown pipeline](https://github.com/block/buzz/blob/33f54de2dd27a8f6bce0d359183f5ebe5f2fa9ba/desktop/src/shared/ui/markdown/nodeCache.ts).

The proxy implements this protocol directly using `nostr-tools`, avoiding a runtime dependency on the Buzz CLI or a full Buzz/Rust installation.

## Sender behavior

- **Prometheus Alertmanager** can point `slack_configs.api_url` or `api_url_file` to the proxy. Its Slack receiver sends a legacy attachment, so attachment support is a first-class requirement. Native `webhook_configs` is an alternative. [Official Alertmanager configuration](https://prometheus.io/docs/alerting/latest/configuration/#slack_config).
- **Grafana** supports a Slack contact point using a webhook URL. Its built-in Slack integration allows title/body customization but not arbitrary Block Kit layouts. Native webhook contact points expose useful structured alert details. [Slack contact point](https://grafana.com/docs/grafana/latest/alerting/configure-notifications/manage-contact-points/integrations/configure-slack/), [native webhook contact point](https://grafana.com/docs/grafana/latest/alerting/configure-notifications/manage-contact-points/integrations/webhook-notifier/).
- For file provisioning, the incoming Slack URL belongs in the receiver's `settings.url`. Do not confuse that file schema with API payloads using `secureSettings`. Environment expansion can supply the secret at deployment. [Official file provisioning](https://grafana.com/docs/grafana/latest/alerting/set-up/provision-alerting-resources/file-provisioning/).
- Slack's mrkdwn has special angle-bracket links, mentions, entities, and different emphasis conventions from normal Markdown. Preserve code spans while converting. [Formatting reference](https://docs.slack.dev/messaging/formatting-message-text/).
- Slack's block catalog is evolving; current docs include additional card/container/data-oriented blocks. The adapter must publish a tested support matrix instead of claiming all Block Kit support. [Official block reference](https://docs.slack.dev/reference/block-kit/blocks/).

## Unverified deployment assumptions

- The user's actual relay URL, Buzz version, bot admission process, and channel UUID are unknown.
- NIP-OA delegation is supported as a configured `x-auth-tag` header. Generating the owner attestation is outside this prototype.
- Some deployments may enforce additional identity policies such as **NIP-FI**. A bare bot key/NIP-98 proof may then be insufficient. The current client does not acquire or refresh NIP-FI assertions; validate the target relay's policy before claiming compatibility. [Pinned NIP-FI spec](https://github.com/block/buzz/blob/33f54de2dd27a8f6bce0d359183f5ebe5f2fa9ba/docs/nips/NIP-FI.md).
- Rendering must still be visually checked in the actual Buzz desktop/mobile version. Remote images may require accessible URLs, and notification behavior depends on client preferences and relay policy.
- Real Prometheus/Grafana sender payloads, provisioned credentials, container permissions, and reverse-proxy behavior need the integration milestone in the handoff.

Research claims describe the inspected source and documentation, not an observed hosted end-to-end deployment.
