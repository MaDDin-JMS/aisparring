// End-to-end tests: starts real server processes on temporary databases and talks HTTP to them.
// Run with: npm test   (or in Docker: see README → Development)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

const freePort = () => new Promise((resolve) => {
  const s = createServer().listen(0, () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

async function startServer(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aichat-test-'));
  const port = await freePort();
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DB_PATH: join(dir, 'aichat.db'), SECURE_COOKIES: 'false', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  const keyFile = join(dir, 'initial-admin-key.txt');
  const admin = existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : null;
  return { base, admin, log: () => log, stop: () => { proc.kill(); rmSync(dir, { recursive: true, force: true }); } };
}

let srv;
const api = async (path, { key, method = 'GET', body, headers = {}, raw } = {}) => {
  const res = await fetch(`${srv.base}${path}`, {
    method,
    headers: {
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, json, text, headers: res.headers };
};

const mcp = async (key, method, params = {}) => {
  const res = await api('/mcp', { key, method: 'POST', body: { jsonrpc: '2.0', id: 1, method, params }, headers: { Accept: 'application/json, text/event-stream' } });
  return res.json;
};
const callTool = async (key, name, args = {}) => (await mcp(key, 'tools/call', { name, arguments: args })).result;

let A; let C; let G; // admin, Claude, GPT

before(async () => {
  srv = await startServer();
  A = srv.admin;
  C = (await api('/api/admin/keys', { key: A, method: 'POST', body: { name: 'Claude', kind: 'ai' } })).json.token;
  G = (await api('/api/admin/keys', { key: A, method: 'POST', body: { name: 'GPT', kind: 'ai' } })).json.token;
});
after(() => srv?.stop());

test('starts, logs no key, creates admin key file', () => {
  assert.match(A, /^aic_[A-Za-z0-9_-]{32}$/);
  assert.doesNotMatch(srv.log(), /aic_[A-Za-z0-9_-]{20,}/);
});

test('security headers are set', async () => {
  const { headers } = await api('/');
  assert.match(headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(headers.get('referrer-policy'), 'no-referrer');
  assert.equal(headers.get('x-frame-options'), 'DENY');
  // HSTS only when served over HTTPS (via the proxy), never on plain HTTP
  assert.equal(headers.get('strict-transport-security'), null);
  const viaHttps = await api('/', { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.match(viaHttps.headers.get('strict-transport-security'), /max-age=/);
});

test('auth: valid, invalid, missing', async () => {
  assert.equal((await api('/api/me', { key: C })).json.me.name, 'Claude');
  assert.equal((await api('/api/me', { key: 'aic_wrong' })).status, 401);
  assert.equal((await api('/api/me')).status, 401);
});

test('responses never contain secrets', async () => {
  const { text } = await api('/api/admin/keys', { key: A });
  for (const k of [A, C, G]) assert.ok(!text.includes(k));
  assert.doesNotMatch(text, /token_hash/);
});

test('browser session: cookie is not the key, logout and rotate end it', async () => {
  const login = await api('/api/session', { method: 'POST', body: { key: C } });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.match(cookie, /^aichat_session=aics_/);
  assert.ok(!cookie.includes(C));
  assert.equal((await api('/api/me', { headers: { Cookie: cookie } })).status, 200);
  // cookie-authenticated non-JSON write is refused (CSRF)
  assert.equal((await api('/api/channels/general/messages', { method: 'POST', raw: 'content=x', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 415);
  await api('/api/session', { method: 'DELETE', body: {}, headers: { Cookie: cookie } });
  assert.equal((await api('/api/me', { headers: { Cookie: cookie } })).status, 401);
});

test('rotating your own key: old key and sessions stop working', async () => {
  const { json } = await api('/api/admin/keys', { key: A, method: 'POST', body: { name: 'Temp', kind: 'human' } });
  const old = json.token;
  const cookie = (await api('/api/session', { method: 'POST', body: { key: old } })).headers.get('set-cookie').split(';')[0];
  const rotated = await api('/api/me/rotate', { key: old, method: 'POST', body: {} });
  assert.equal(rotated.status, 200);
  assert.equal((await api('/api/me', { key: old })).status, 401);
  assert.equal((await api('/api/me', { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await api('/api/me', { key: rotated.json.token })).status, 200);
});

test('channel permissions: private, read-only, write', async () => {
  const ch = (await api('/api/admin/channels', { key: A, method: 'POST', body: { slug: 'secret', is_open: false } })).json.channel;
  const gptId = (await api('/api/admin/keys', { key: A })).json.keys.find((k) => k.name === 'GPT').id;
  assert.equal((await api('/api/channels/secret/messages', { key: G })).status, 404);
  await api(`/api/admin/channels/${ch.id}/access/${gptId}`, { key: A, method: 'PUT', body: { level: 'read' } });
  assert.equal((await api('/api/channels/secret/messages', { key: G })).status, 200);
  assert.equal((await api('/api/channels/secret/messages', { key: G, method: 'POST', body: { content: 'hi' } })).status, 403);
  assert.equal((await api('/api/admin/keys', { key: G })).status, 403);
});

test('posting a key is refused (message and attachment)', async () => {
  const r = await api('/api/channels/general/messages', { key: C, method: 'POST', body: { content: `my key is ${C}` } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /looks like an AIChat key/);
  const up = await api('/api/uploads', { key: C, method: 'POST', raw: `token=${G}`, headers: { 'Content-Type': 'text/plain', 'X-Filename': 'leak.txt' } });
  assert.equal(up.status, 400);
  const viaMcp = await callTool(C, 'post_message', { channel: 'general', content: 'here', attachments: [{ filename: 'k.txt', text: A }] });
  assert.ok(viaMcp.isError);
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const upload = (key, data, name, type = 'application/octet-stream') =>
  api('/api/uploads', { key, method: 'POST', raw: data, headers: { 'Content-Type': type, 'X-Filename': encodeURIComponent(name) } });

test('attachments: type sniffing, safe delivery, access control', async () => {
  const png = (await upload(C, PNG, 'pic.png', 'text/plain')).json.attachment;
  assert.equal(png.kind, 'image');
  assert.equal(png.mime, 'image/png');
  const svg = (await upload(C, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'x.svg', 'image/svg+xml')).json.attachment;
  assert.equal(svg.kind, 'file');
  // pending uploads are private to the uploader
  assert.equal((await api(png.url, { key: G })).status, 404);
  const msg = (await api('/api/channels/secret/messages', { key: A, method: 'POST', body: { content: '', attachments: [png.id, svg.id] } }));
  assert.equal(msg.status, 400, 'admin cannot attach uploads of another key');
  const posted = await api('/api/channels/general/messages', { key: C, method: 'POST', body: { content: 'files', attachments: [png.id, svg.id] } });
  assert.equal(posted.status, 201);
  assert.equal(posted.json.message.attachments.length, 2);
  const img = await api(png.url, { key: G });
  assert.equal(img.headers.get('content-type'), 'image/png');
  const file = await api(svg.url, { key: G });
  assert.equal(file.headers.get('content-type'), 'application/octet-stream');
  assert.match(file.headers.get('content-disposition'), /^attachment/);
  assert.match(file.headers.get('content-security-policy'), /sandbox/);
  // reusing an attached upload is refused
  assert.equal((await api('/api/channels/general/messages', { key: C, method: 'POST', body: { content: 'again', attachments: [png.id] } })).status, 400);
});

test('attachments: max 10 images and 5 files per post, size limit', async () => {
  const files = [];
  for (let i = 0; i < 6; i++) files.push((await upload(C, `data ${i}`, `f${i}.txt`, 'text/plain')).json.attachment.id);
  assert.equal((await api('/api/channels/general/messages', { key: C, method: 'POST', body: { content: 'x', attachments: files } })).status, 400);
  assert.equal((await api('/api/channels/general/messages', { key: C, method: 'POST', body: { content: 'x', attachments: files.slice(0, 5) } })).status, 201);
  const images = [];
  for (let i = 0; i < 11; i++) images.push((await upload(C, PNG, `i${i}.png`)).json.attachment.id);
  assert.equal((await api('/api/channels/general/messages', { key: C, method: 'POST', body: { content: 'x', attachments: images } })).status, 400);
  assert.equal((await api('/api/channels/general/messages', { key: C, method: 'POST', body: { content: 'x', attachments: images.slice(0, 10) } })).status, 201);
  assert.equal((await upload(C, Buffer.alloc(11 * 1024 * 1024), 'big.bin')).status, 413);
});

test('MCP: tools, posting with attachments, waiting for replies', async () => {
  const init = await mcp(C, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.match(init.result.instructions, /Never post it/);
  const tools = (await mcp(C, 'tools/list')).result.tools.map((t) => t.name);
  for (const t of ['list_channels', 'read_messages', 'post_message', 'wait_for_messages', 'get_attachment']) assert.ok(tools.includes(t), t);

  const last = (await api('/api/channels/general/messages?limit=1', { key: G })).json.messages.at(-1).id;
  const waiting = callTool(G, 'wait_for_messages', { after_id: last, channel: 'general', timeout_seconds: 10 });
  await new Promise((r) => setTimeout(r, 300));
  const post = await callTool(C, 'post_message', { channel: 'general', content: '@GPT thoughts?', attachments: [{ filename: 'notes.md', text: '# Notes' }] });
  assert.match(post.content[0].text, /with 1 attachment/);
  const woke = await waiting;
  assert.match(woke.content[0].text, /@GPT thoughts\?/);
  const id = woke.content[0].text.match(/get_attachment id="([^"]+)"/)[1];
  const att = await callTool(G, 'get_attachment', { id });
  assert.match(att.content[0].text, /# Notes/);
  const noKey = await api('/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  assert.equal(noKey.status, 401);
});

test('brute force: an IP is blocked after 20 wrong keys', async () => {
  for (let i = 0; i < 20; i++) await api('/api/me', { key: `aic_guess${i}` });
  assert.equal((await api('/api/me', { key: 'aic_guess-final' })).status, 429);
  assert.equal((await api('/api/me', { key: C })).status, 429, 'even a valid key is refused while blocked');
  assert.equal((await api('/api/session', { method: 'POST', body: { key: C } })).status, 429);
});

test('expired attachments are deleted and marked', async () => {
  const s = await startServer({ ATTACHMENT_RETENTION_DAYS: String(1 / 86400) }); // one second
  try {
    const call = (path, opts = {}) => fetch(`${s.base}${path}`, { ...opts, headers: { Authorization: `Bearer ${s.admin}`, ...opts.headers } });
    const up = await (await call('/api/uploads', { method: 'POST', body: 'hello', headers: { 'Content-Type': 'text/plain', 'X-Filename': 'a.txt' } })).json();
    await call('/api/channels/general/messages', { method: 'POST', body: JSON.stringify({ content: 'f', attachments: [up.attachment.id] }), headers: { 'Content-Type': 'application/json' } });
    const tmp = await (await call('/api/channels/general/messages', { method: 'POST', body: JSON.stringify({ content: 'tmp' }), headers: { 'Content-Type': 'application/json' } })).json();
    await new Promise((r) => setTimeout(r, 1500));
    await call(`/api/messages/${tmp.message.id}`, { method: 'DELETE' }); // triggers the cleanup
    const { messages } = await (await call('/api/channels/general/messages')).json();
    assert.equal(messages.at(-1).attachments[0].expired, true);
    assert.equal((await call(up.attachment.url)).status, 410);
  } finally {
    s.stop();
  }
});
