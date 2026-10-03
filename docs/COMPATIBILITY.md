# Compatibility matrix

“Supported” means content is converted to Buzz Markdown. It does not mean identical Slack layout, styling, interaction, or notification behavior.

| Input | Behavior |
|---|---|
| Top-level text | Slack mrkdwn conversion; `mrkdwn:false` escapes formatting |
| Top-level fallback with blocks | Rendered blocks replace duplicate fallback text |
| Header / section / fields | Headings and stacked Markdown fields |
| Divider / context | Markdown separator / inline context |
| Image | HTTP(S) Markdown image; no proxy fetch, upload, or private Slack file resolution |
| Actions / URL button | Clickable ordinary link |
| Callback/workflow button | Label plus unavailable-action marker |
| Rich text | Sections, styled text, links, emoji shortcodes, users, lists, quotes, code, dates |
| Table | GFM table with the first row as the header; column widths/alignment styling omitted |
| Markdown block | Standard Markdown passthrough |
| Video | Title/link, description and optional thumbnail; no embedded Slack video player |
| Input / select / picker | Label/initial option where available, plus unavailable-control marker |
| File / private Slack image | Visible unavailable reference; requires a separate Slack integration |
| New/unknown block | Recognized nested text/blocks plus explicit unsupported marker and warning |
| Legacy attachments | Pretext, author link/name, title/link, fields, mrkdwn_in, fallback, footer/time, images/actions |
| Attachment color | Red/green/orange markers for common values; arbitrary side-bar colors cannot be reproduced |
| Slack URL markup | Converted to safe HTTP(S)/mailto Markdown links |
| Slack user mention | Optional configured public-key mapping; otherwise readable `@ID` or supplied name |
| Channel / user-group mention | Readable text, no Slack directory lookup |
| `here` / `channel` / `everyone` | Text by default; optional Buzz channel broadcast, with no active-user-only equivalent |
| Slack date tokens | Supplied fallback text; no Slack-localized date formatting |
| Emoji | Unicode preserved; shortcode text retained; no custom emoji palette lookup/upload |
| `channel` | Ignored for destination selection; route configuration is authoritative |
| `username`, `icon_*` | Ignored for authorship; fixed Buzz profile |
| `thread_ts` | Rejected with 400; no misleading unthreaded success |
| `chat.postMessage`, `chat.update` | Not implemented; configure incoming webhooks |
| Native Alertmanager/Grafana | Default `status` + `alerts` format; grouped alerts rendered individually |
| Native Grafana custom `message` | Structured alert data is authoritative; arbitrary message templates are not rendered |
| Grafana HMAC authentication | Not implemented; use per-route URL secret or Bearer header |
| Oversized input/output | 413 before enqueue; no automatic splitting or silent truncation |

The renderer prevents non-HTTP media URLs and unsafe button URL schemes. It does not sanitize arbitrary standard Markdown into a new security policy: Buzz's own renderer controls clickable links/media. The proxy itself never fetches sender-supplied image or button URLs.

For major new blocks, add a synthetic fixture and explicit expected output before expanding this table. For interactive callbacks, design a separate authenticated interaction service; do not reinterpret arbitrary `action_id` or `value` fields as executable commands.
