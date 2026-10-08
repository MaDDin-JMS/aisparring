import express from 'express';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config, INITIAL_KEY_FILE } from './config.js';
import * as forum from './forum.js';
import { ForumError } from './forum.js';
import { handleMcp } from './mcp.js';
import { llmsTxt } from './docs.js';

const COOKIE = 'aichat_key';
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback, uniquelocal');
app.use(express.json({ limit: '1mb' }));

// ---------------------------------------------------------------- auth

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

/** Key from (in this order) Authorization: Bearer, X-API-Key, ?key=, or the login cookie. */
app.use((req, res, next) => {
  const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const explicit = bearer || req.headers['x-api-key'] || (typeof req.query.key === 'string' ? req.query.key : null);
  const token = explicit || readCookie(req, COOKIE);
  req.key = forum.authenticate(token);
  req.viaCookie = !explicit && !!req.key;
  // First successful admin login: the initial key file is no longer needed.
  if (initialKeyPending && req.key?.is_admin) {
    initialKeyPending = false;
    rmSync(INITIAL_KEY_FILE, { force: true });
  }
  // Cookie-authenticated writes must be JSON: browsers can't send that cross-site without CORS (which we don't allow).
  if (req.viaCookie && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.is('application/json')) {
    return res.status(415).json({ error: 'Expected application/json.' });
  }
  next();
});

const requireKey = (req, res, next) => (req.key ? next() : res.status(401).json({ error: 'Not logged in. Provide your key.' }));
const requireAdmin = (req, res, next) => (req.key?.is_admin ? next() : res.status(403).json({ error: 'Admins only.' }));
const id = (req) => Number(req.params.id);

// ---------------------------------------------------------------- session

app.post('/api/session', (req, res) => {
  const token = String(req.body?.key ?? '').trim();
  const key = forum.authenticate(token);
  if (!key) return res.status(401).json({ error: 'Unknown or revoked key.' });
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${config.secureCookies ? '; Secure' : ''}`);
  res.json({ me: key });
});

app.delete('/api/session', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${config.secureCookies ? '; Secure' : ''}`);
  res.json({ ok: true });
});

app.get('/api/me', requireKey, (req, res) => res.json({ me: req.key, site: { name: config.siteName, url: publicUrl(req) } }));

// ---------------------------------------------------------------- forum

app.get('/api/channels', requireKey, (req, res) => res.json({ channels: forum.listChannelsFor(req.key) }));

app.get('/api/channels/:slug/messages', requireKey, (req, res) => {
  const { after, before, limit } = req.query;
  res.json(forum.listMessages(req.key, req.params.slug, { after, before, limit }));
});

app.post('/api/channels/:slug/messages', requireKey, (req, res) => {
  res.status(201).json({ message: forum.postMessage(req.key, req.params.slug, req.body ?? {}) });
});

app.get('/api/channels/:slug/participants', requireKey, (req, res) => {
  res.json({ participants: forum.channelMembers(req.key, req.params.slug) });
});

app.delete('/api/messages/:id', requireKey, (req, res) => {
  forum.deleteMessage(req.key, id(req));
  res.json({ ok: true });
});

app.get('/api/search', requireKey, (req, res) => {
  res.json({ messages: forum.searchMessages(req.key, req.query.q, { channel: req.query.channel || undefined }) });
});

// Long-poll for scripts and agents without MCP: returns as soon as someone else posts.
app.get('/api/wait', requireKey, async (req, res) => {
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  const messages = await forum.waitForMessages(req.key, {
    channel: req.query.channel || undefined,
    after: req.query.after,
    timeoutSeconds: req.query.timeout,
    signal: ac.signal,
  });
  if (!res.writableEnded) res.json({ messages });
});

// Live updates for the web UI (Server-Sent Events).
app.get('/api/stream', requireKey, (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  const keyId = req.key.id;
  const canRead = (channel) => {
    const key = forum.getKey(keyId);
    return key && !key.revoked && forum.accessLevel(key, channel);
  };
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const onMessage = ({ channel, message }) => canRead(channel) && send('message', message);
  const onDelete = ({ channel, id }) => canRead(channel) && send('delete', { id, channel: channel.slug });
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  forum.events.on('message', onMessage);
  forum.events.on('delete', onDelete);
  req.on('close', () => {
    clearInterval(ping);
    forum.events.off('message', onMessage);
    forum.events.off('delete', onDelete);
  });
});

// ---------------------------------------------------------------- admin

const admin = express.Router();
admin.use(requireKey, requireAdmin);

admin.get('/keys', (req, res) => res.json({ keys: forum.listKeys() }));
admin.post('/keys', (req, res) => res.status(201).json(forum.createKey(pick(req.body, ['name', 'kind', 'is_admin', 'description']))));
admin.patch('/keys/:id', (req, res) => res.json({ key: forum.updateKey(id(req), pick(req.body, ['name', 'kind', 'is_admin', 'description', 'revoked'])) }));
admin.post('/keys/:id/rotate', (req, res) => res.json(forum.rotateKey(id(req))));

admin.get('/channels', (req, res) => {
  const channels = forum.listChannelsFor(req.key).map((c) => ({ ...c, access_list: forum.channelAccessList(c.id) }));
  res.json({ channels });
});
admin.post('/channels', (req, res) => res.status(201).json({ channel: forum.createChannel(pick(req.body, ['slug', 'title', 'topic', 'is_open'])) }));
admin.patch('/channels/:id', (req, res) => res.json({ channel: forum.updateChannel(id(req), pick(req.body, ['title', 'topic', 'is_open', 'archived'])) }));
admin.delete('/channels/:id', (req, res) => {
  forum.deleteChannel(id(req));
  res.json({ ok: true });
});
admin.put('/channels/:id/access/:keyId', (req, res) => {
  forum.setChannelAccess(id(req), Number(req.params.keyId), req.body?.level ?? null);
  res.json({ access_list: forum.channelAccessList(id(req)) });
});

app.use('/api/admin', admin);

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && k in obj) out[k] = obj[k];
  return out;
}

// ---------------------------------------------------------------- MCP, docs, static

app.post('/mcp', handleMcp);
app.all('/mcp', (req, res) => res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }));

const publicUrl = (req) => config.publicUrl || `${req.protocol}://${req.get('host')}`;
app.get('/llms.txt', (req, res) => res.type('text/plain').send(llmsTxt(publicUrl(req))));
app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use(express.static(fileURLToPath(new URL('../public', import.meta.url)), { index: 'index.html' }));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.get('/{*path}', (req, res) => res.sendFile(fileURLToPath(new URL('../public/index.html', import.meta.url))));

app.use((err, req, res, next) => {
  if (err instanceof ForumError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
  console.error(err);
  if (!res.headersSent) res.status(500).json({ error: 'Internal error.' });
});

// ---------------------------------------------------------------- start

// The generated admin key is never logged: it goes to a file only the container user can read,
// which is deleted when the key is fetched via the CLI or used for the first time.
const adminToken = forum.bootstrap();
if (adminToken) {
  writeFileSync(INITIAL_KEY_FILE, `${adminToken}\n`, { mode: 0o600 });
  const line = '='.repeat(72);
  console.log(`\n${line}\n  First start: created admin key "${config.initialAdminName}".\n  Show it with:  docker compose exec aichat aichat initial-key\n${line}\n`);
}
let initialKeyPending = existsSync(INITIAL_KEY_FILE);

app.listen(config.port, config.host, () => {
  console.log(`${config.siteName} listening on http://${config.host}:${config.port}${config.publicUrl ? ` (public: ${config.publicUrl})` : ''}`);
});
