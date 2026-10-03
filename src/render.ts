import { nip19 } from 'nostr-tools';
import { arr, InputError, join, obj, str, validateTree, type Obj, type Rendered, type RenderOptions } from './types.js';

const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
export const escapeMd = (s: string) => s.replace(/[\\`*_{}\[\]<>~|]/g, '\\$&').replace(/^(\s*)([#>+-]|\d+\.) /gm, '$1\\$2 ');
const label = (s: string) => escapeMd(s.replace(/\s+/g, ' '));
function safeUrl(value: unknown, image = false): string | undefined {
  try {
    const u = new URL(decode(str(value)));
    if (!(image ? ['https:', 'http:'] : ['https:', 'http:', 'mailto:']).includes(u.protocol) || u.username || u.password) return;
    return u.href.replace(/[()<>]/g, c => '%' + c.charCodeAt(0).toString(16));
  } catch { return; }
}
const link = (text: string, url: unknown) => { const u = safeUrl(url); return u ? `[${label(text || u)}](${u})` : label(text); };
const code = (text: string) => {
  const ticks = '`'.repeat(Math.max(2, ...[...text.matchAll(/`+/g)].map(m => m[0].length + 1)));
  return `${ticks} ${text.replace(/\n/g, ' ')} ${ticks}`;
};
const fence = (text: string) => {
  const ticks = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(m => m[0].length + 1)));
  return `${ticks}\n${text}\n${ticks}`;
};

class Renderer {
  warnings = new Set<string>();
  mentions = new Set<string>();
  broadcast = false;
  constructor(private options: RenderOptions) {}
  warn(kind: string) { this.warnings.add(kind); }
  user(id: string, fallback?: string) {
    const key = Object.hasOwn(this.options.users ?? {}, id) ? this.options.users?.[id] : undefined;
    if (key && /^[a-f0-9]{64}$/i.test(key)) { this.mentions.add(key.toLowerCase()); return `nostr:${nip19.npubEncode(key)}`; }
    this.warn('unmapped_slack_user');
    return label(`@${fallback || id}`);
  }
  mentionAll(scope: string) {
    if (this.options.allowBroadcast) this.broadcast = true;
    else this.warn('broadcast_disabled');
    return label(`@${scope}`);
  }
  mrkdwn(raw: string): string {
    // Protect code and generated links while translating Slack's single-marker emphasis.
    const parts = raw.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
    return parts.map((part, i) => {
      if (i % 2) return part;
      const held: string[] = [];
      const hold = (s: string) => { held.push(s); return `\u0000${held.length - 1}\u0000`; };
      let s = part.replace(/\u0000/g, '').replace(/<([^<>]+)>/g, (_, inside: string) => {
        const bar = inside.indexOf('|');
        const target = bar < 0 ? inside : inside.slice(0, bar);
        const title = bar < 0 ? '' : decode(inside.slice(bar + 1));
        if (target.startsWith('@')) return hold(this.user(target.slice(1), title));
        if (target.startsWith('#')) return hold(label(`#${title || target.slice(1)}`));
        if (/^!(here|channel|everyone)$/.test(target)) return hold(this.mentionAll(target.slice(1)));
        if (target.startsWith('!subteam^')) { this.warn('unmapped_slack_group'); return hold(label(title || '@' + target.slice(9))); }
        if (target.startsWith('!date^')) return hold(label(title || 'Slack date'));
        return hold(safeUrl(target) ? link(title || decode(target), target) : escapeMd(decode(`<${inside}>`)));
      });
      s = decode(s).replace(/</g, '&lt;');
      s = s.replace(/(^|[^\w*])\*([^*\n]+)\*(?!\*)/g, '$1**$2**')
        .replace(/(^|[^\w~])~([^~\n]+)~(?!~)/g, '$1~~$2~~');
      return s.replace(/\u0000(\d+)\u0000/g, (_, n: string) => held[Number(n)] ?? '');
    }).join('');
  }
  text(value: unknown): string {
    if (typeof value === 'string') return this.mrkdwn(value);
    const t = obj(value);
    return t.type === 'plain_text' ? escapeMd(str(t.text)) : this.mrkdwn(str(t.text));
  }
  image(value: Obj): string {
    const url = safeUrl(value.image_url, true);
    const alt = str(value.alt_text) || 'Image';
    if (!url) { this.warn('image_unavailable'); return `[${label(alt)} — image unavailable]`; }
    return `![${label(alt)}](${url})`;
  }
  element(value: unknown): string {
    const e = obj(value); const type = str(e.type);
    if (type === 'image') return this.image(e);
    if (type === 'plain_text' || type === 'mrkdwn') return this.text(e);
    if (type === 'button' || type === 'workflow_button') {
      const text = str(obj(e.text).text) || str(e.text) || 'Button';
      if (safeUrl(e.url)) return link(text, e.url);
      this.warn('interactive_element'); return `${label(text)} _(Slack action unavailable)_`;
    }
    this.warn('interactive_element');
    const selected = arr(e.initial_options).map(o => this.text(obj(o).text));
    if (e.initial_option) selected.push(this.text(obj(e.initial_option).text));
    return join([this.text(e.placeholder) || label(type || 'Control'), ...selected, '_Interactive control unavailable_'], ' — ');
  }
  rich(value: unknown): string {
    const e = obj(value); const type = str(e.type);
    if (type === 'text' || type === 'raw_text') {
      const style = obj(e.style); let s = escapeMd(str(e.text));
      if (style.code) return code(str(e.text));
      if (style.bold) s = `**${s}**`;
      if (style.italic) s = `_${s}_`;
      if (style.strike) s = `~~${s}~~`;
      return s;
    }
    if (type === 'link') return link(str(e.text) || str(e.url), e.url);
    if (type === 'emoji') return `:${label(str(e.name))}:`;
    if (type === 'user') return this.user(str(e.user_id));
    if (type === 'channel') return label('#' + str(e.channel_id));
    if (type === 'usergroup') { this.warn('unmapped_slack_group'); return label('@' + str(e.usergroup_id)); }
    if (type === 'broadcast') return this.mentionAll(str(e.range));
    if (type === 'date') return label(str(e.fallback) || this.date(e.timestamp));
    const children = arr(e.elements);
    if (type === 'rich_text_preformatted') return fence(children.map(c => str(obj(c).text)).join(''));
    const rendered = children.map(c => this.rich(c));
    if (type === 'rich_text_quote') return rendered.join('').split('\n').map(s => '> ' + s).join('\n');
    if (type === 'rich_text_list') {
      const indent = '  '.repeat(Math.min(8, Math.max(0, Number(e.indent) || 0)));
      const offset = Math.max(0, Number(e.offset) || 0);
      return rendered.map((s, i) => `${indent}${e.style === 'ordered' ? i + offset + 1 + '.' : '-'} ${s.replace(/\n/g, '\n' + indent + '  ')}`).join('\n');
    }
    if (type === 'rich_text_section') return rendered.join('');
    if (type === 'rich_text') return rendered.join('\n\n');
    this.warn('unsupported_rich_text');
    return rendered.join('') || this.text(e.text) || `[Unsupported rich text: ${label(type)}]`;
  }
  block(value: unknown): string {
    const b = obj(value); const type = str(b.type);
    switch (type) {
      case 'header': return `### ${this.text(b.text)}`;
      case 'section': return join([this.text(b.text), ...arr(b.fields).map(f => this.text(f)), b.accessory ? this.element(b.accessory) : '']);
      case 'divider': return '---';
      case 'context': return arr(b.elements).map(e => this.element(e)).join(' · ');
      case 'actions': case 'context_actions': return arr(b.elements).map(e => this.element(e)).join(' · ');
      case 'image': return join([this.text(b.title), this.image(b)]);
      case 'rich_text': return this.rich(b);
      case 'markdown': return str(b.text); // This block already contains standard Markdown.
      case 'table': {
        const rows = arr(b.rows).map(r => arr(r).map(c => this.rich(c).replace(/\|/g, '\\|').replace(/\n/g, '<br>')));
        const width = Math.max(0, ...rows.map(r => r.length));
        if (!width) return '';
        const line = (row: string[]) => '| ' + Array.from({ length: width }, (_, i) => row[i] || '').join(' | ') + ' |';
        return [line(rows[0]!), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n');
      }
      case 'video': return join([link(str(obj(b.title).text) || 'Video', b.title_url || b.video_url), this.text(b.description), b.thumbnail_url ? this.image({ image_url: b.thumbnail_url, alt_text: b.alt_text || 'Video thumbnail' }) : '']);
      case 'input': this.warn('interactive_element'); return join([this.text(b.label), this.element(b.element)]);
      case 'file': this.warn('slack_file_unavailable'); return `[Slack file ${label(str(b.external_id) || str(b.file_id))} — requires Slack access]`;
      default: {
        // Retain content of newer container/card blocks without claiming visual parity.
        this.warn('unsupported_block:' + type.replace(/[^a-z_]/g, '').slice(0, 40));
        return join([this.text(b.title), this.text(b.text), this.text(b.description), ...arr(b.blocks).map(c => this.block(c)), ...arr(b.elements).map(e => this.element(e)), `[Unsupported Slack block: ${label(type || 'unknown')}]`]);
      }
    }
  }
  date(value: unknown): string {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 253402300799) return '';
    return new Date(n * 1000).toISOString();
  }
  attachment(value: unknown): string {
    const a = obj(value);
    const color = str(a.color).toLowerCase();
    const marker = color === 'danger' || color === '#ff0000' ? '🔴' : color === 'good' || color === '#36a64f' ? '🟢' : color === 'warning' ? '🟠' : '';
    const md = new Set(arr(a.mrkdwn_in).map(str));
    const fieldText = (key: string, v: unknown) => md.has(key) ? this.mrkdwn(str(v)) : escapeMd(str(v));
    const main = join([
      fieldText('pretext', a.pretext),
      a.author_name ? link(str(a.author_name), a.author_link) : '',
      a.title ? `### ${join([marker, link(str(a.title), a.title_link)], ' ')}` : marker,
      fieldText('text', a.text),
      ...arr(a.fields).map(f => { const o = obj(f); return join([o.title ? `**${label(str(o.title))}**` : '', fieldText('fields', o.value)], '\n'); }),
      ...arr(a.blocks).map(b => this.block(b)),
      ...arr(a.actions).map(e => this.element({ ...obj(e), type: obj(e).type || 'button' })),
      a.image_url ? this.image({ image_url: a.image_url, alt_text: a.title || 'Alert image' }) : '',
      a.thumb_url && a.thumb_url !== a.image_url ? this.image({ image_url: a.thumb_url, alt_text: 'Thumbnail' }) : '',
    ]);
    const body = main || this.mrkdwn(str(a.fallback));
    return join([body, join([escapeMd(str(a.footer)), a.ts !== undefined ? this.date(a.ts) : ''], ' · ')]);
  }
  slack(p: Obj): string {
    if (p.thread_ts) throw new InputError(400, 'slack_threads_not_supported');
    if (p.blocks !== undefined && !Array.isArray(p.blocks)) throw new InputError(400, 'invalid_blocks');
    if (p.attachments !== undefined && !Array.isArray(p.attachments)) throw new InputError(400, 'invalid_attachments');
    // Slack top-level text is a notification fallback when blocks are supplied.
    const blocks = arr(p.blocks).map(b => this.block(b)).filter(Boolean);
    if (p.username || p.icon_url || p.icon_emoji) this.warn('buzz_profile_is_fixed');
    if (p.channel) this.warn('channel_fixed_by_route');
    return join([blocks.length ? blocks.join('\n\n') : p.mrkdwn === false ? escapeMd(str(p.text)) : this.mrkdwn(str(p.text)), ...arr(p.attachments).map(a => this.attachment(a))]);
  }
  alerts(p: Obj): string {
    const alerts = arr(p.alerts);
    if (!alerts.length) throw new InputError(400, 'no_alerts');
    if (!['firing', 'resolved'].includes(str(p.status))) throw new InputError(400, 'invalid_alert_status');
    const heading = str(p.title) || `${str(p.status).toUpperCase()}: ${str(obj(p.commonLabels).alertname) || 'Alerts'} (${alerts.length})`;
    const items = alerts.map(value => {
      const a = obj(value); const labels = obj(a.labels); const annotations = obj(a.annotations);
      if (!['firing', 'resolved'].includes(str(a.status))) throw new InputError(400, 'invalid_alert_status');
      return join([
        `### ${a.status === 'resolved' ? '🟢' : '🔴'} ${label(str(labels.alertname) || 'Alert')}`,
        ...Object.entries(annotations).map(([k, v]) => `**${label(k)}:** ${escapeMd(str(v))}`),
        Object.keys(labels).length ? Object.entries(labels).map(([k, v]) => `${code(k)} = ${code(str(v))}`).join('\n') : '',
        a.values ? `**Values:** ${code(JSON.stringify(a.values))}` : str(a.valueString) ? `**Values:** ${code(str(a.valueString))}` : '',
        join([a.startsAt ? `Started: ${label(str(a.startsAt))}` : '', a.status === 'resolved' && a.endsAt ? `Ended: ${label(str(a.endsAt))}` : ''], '\n'),
        join([['Source', a.generatorURL], ['Dashboard', a.dashboardURL], ['Panel', a.panelURL], ['Silence', a.silenceURL]].filter(([, u]) => safeUrl(u)).map(([t, u]) => link(str(t), u)), ' · '),
        a.imageURL ? this.image({ image_url: a.imageURL, alt_text: 'Alert graph' }) : '',
      ]);
    });
    return join([`## ${label(heading)}`, ...items, p.truncatedAlerts ? `⚠️ Sender omitted ${label(String(p.truncatedAlerts))} alerts.` : '', safeUrl(p.externalURL) ? link('Alert manager', p.externalURL) : '']);
  }
}

export function renderPayload(payload: unknown, options: RenderOptions = {}): Rendered {
  validateTree(payload);
  const r = new Renderer(options);
  const format = Array.isArray(payload.alerts) ? 'alertmanager' : 'slack';
  const content = (format === 'alertmanager' ? r.alerts(payload) : r.slack(payload)).trim();
  if (!content) throw new InputError(400, 'no_text');
  if (Buffer.byteLength(content, 'utf8') > 60 * 1024) throw new InputError(413, 'message_too_long');
  if (r.mentions.size > 50) throw new InputError(400, 'too_many_mentions');
  return { content, mentions: [...r.mentions], broadcast: r.broadcast, warnings: [...r.warnings], format };
}
