import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { renderPayload } from '../src/render.js';
const fixture = (file: string) => JSON.parse(readFileSync(new URL(`../examples/${file}`, import.meta.url), 'utf8'));

test('Alertmanager legacy attachments preserve alert fields, formatting, links and timestamps', () => {
  const r = renderPayload(fixture('slack-alertmanager.json'));
  assert.match(r.content, /🔴/); assert.match(r.content, /\*\*checkout\*\*/);
  assert.match(r.content, /\*\*Severity\*\*\ncritical/);
  assert.match(r.content, /\[Silence\]\(https:\/\/alertmanager.example.com\/#\/silences\/new\)/);
  assert.match(r.content, /2026-10/); assert.equal(r.content.includes('FIRING: HighErrorRate'), false);
  assert.ok(r.warnings.includes('channel_fixed_by_route'));
});
test('Block Kit replaces fallback text and renders fields and URL buttons', () => {
  const r = renderPayload(fixture('block-kit.json'));
  assert.match(r.content, /### 🔴 HighErrorRate/); assert.match(r.content, /\*\*Error rate is 8.3%\*\*/);
  assert.match(r.content, /\[Dashboard\]\(https:\/\/grafana.example.com\/d\/checkout\)/);
  assert.equal(r.content.includes('FIRING:'), false); assert.deepEqual(r.warnings, []);
});
test('native Grafana firing/resolved alerts preserve state, labels, annotations, values and links', () => {
  const p = fixture('grafana-webhook.json');
  const r = renderPayload(p);
  for (const expected of ['🔴', 'Checkout error rate', 'checkout', '8.3', '[Silence]', '[Panel]', 'runbook']) assert.ok(r.content.includes(expected), expected);
  assert.equal(r.content.includes('Ended:'), false);
  p.status = 'resolved'; p.alerts[0].status = 'resolved'; p.alerts[0].endsAt = '2026-10-03T02:00:00Z';
  assert.match(renderPayload(p).content, /🟢/); assert.match(renderPayload(p).content, /Ended: 2026/);
});
test('mrkdwn decodes Slack entities, links, mentions and preserves code', () => {
  const pubkey = getPublicKey(generateSecretKey());
  const r = renderPayload({ text: '*bold* _italic_ ~gone~ &amp; &lt;tag&gt; <https://example.com/a?x=1&amp;y=2|A [link]> <@U123> <!channel> `*literal*`\n```*code*```' }, { users: { U123: pubkey } });
  assert.match(r.content, /\*\*bold\*\* _italic_ ~~gone~~/);
  assert.match(r.content, /https:\/\/example.com\/a\?x=1&y=2/);
  assert.ok(r.content.includes(`nostr:${nip19.npubEncode(pubkey)}`)); assert.deepEqual(r.mentions, [pubkey]);
  assert.equal(r.broadcast, false); assert.ok(r.warnings.includes('broadcast_disabled'));
  assert.ok(r.content.includes('`*literal*`')); assert.ok(r.content.includes('```*code*```'));
  assert.equal(renderPayload({ text: '<!here>' }, { allowBroadcast: true }).broadcast, true);
});
test('plain text is not treated as Slack markup', () => {
  assert.equal(renderPayload({ blocks: [{ type: 'section', text: { type: 'plain_text', text: '*literal* <@U123>' } }] }).content, '\\*literal\\* \\<@U123\\>');
});
test('non-URL actions and unknown blocks remain visible', () => {
  const r = renderPayload({ blocks: [
    { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Acknowledge' }, action_id: 'ack' }] },
    { type: 'future_widget', text: { type: 'plain_text', text: 'Important text' } },
    { type: 'image', slack_file: { id: 'F123' }, alt_text: 'Graph' },
  ] });
  assert.match(r.content, /Acknowledge.*unavailable/); assert.match(r.content, /Important text/);
  assert.match(r.content, /Unsupported Slack block/); assert.match(r.content, /Graph.*unavailable/);
});
test('rich text list, quote, preformatted, styles and tables', () => {
  const text = (s: string) => ({ type: 'text', text: s });
  const section = (s: string) => ({ type: 'rich_text_section', elements: [text(s)] });
  const r = renderPayload({ blocks: [
    { type: 'rich_text', elements: [
      { type: 'rich_text_list', style: 'ordered', elements: [section('One'), section('Two')] },
      { type: 'rich_text_quote', elements: [text('Quoted')] },
      { type: 'rich_text_preformatted', elements: [text('*raw*')] },
    ] },
    { type: 'table', rows: [[{ type: 'raw_text', text: 'Name' }], [{ type: 'raw_text', text: 'Value' }]] },
  ] });
  assert.match(r.content, /1\. One\n2\. Two/); assert.match(r.content, /> Quoted/);
  assert.match(r.content, /```\n\*raw\*\n```/); assert.match(r.content, /\| Name \|\n\| --- \|\n\| Value \|/);
});
test('rejects empty, malformed, oversized, over-deep, and Slack-thread payloads', () => {
  for (const p of [null, [], {}, { text: '' }, { blocks: 'bad' }, { alerts: [], status: 'firing' }, { text: 'x', thread_ts: '123.4' }]) assert.throws(() => renderPayload(p));
  assert.throws(() => renderPayload({ text: '🐝'.repeat(16000) }), /message_too_long/);
  let deep: unknown = 'x'; for (let i = 0; i < 30; i++) deep = { nested: deep };
  assert.throws(() => renderPayload({ text: 'x', deep }), /payload_too_complex/);
});
test('untrusted media/button URL schemes are never linked', () => {
  const r = renderPayload({ blocks: [{ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Go' }, url: 'javascript:alert(1)' }] }, { type: 'image', image_url: 'file:///etc/passwd', alt_text: 'private' }] });
  assert.equal(r.content.includes('javascript:'), false); assert.equal(r.content.includes('file:'), false);
});
