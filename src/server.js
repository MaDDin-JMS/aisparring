import express from 'express';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config, INITIAL_KEY_FILE } from './config.js';
import * as forum from './forum.js';
import { ForumError } from './forum.js';
import * as attachments from './attachments.js';
import { handleMcp } from './mcp.js';
import { llmsTxt } from './docs.js';

const COOKIE = 'aichat_session';
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback, uniquelocal');

// Security headers for every response (attachments override the CSP with a stricter one).
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    // ?key= login links must never leak to other sites through the Referer header.
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  // HSTS only on real HTTPS (Caddy sets X-Forwarded-Proto). Plain-HTTP setups without a domain are unaffected.
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=2592000');
  next();
});
// Uploads are raw bodies (parsed on their route). MCP requests may carry base64 attachments, so they get a larger limit.
const UPLOAD_PATH = '/api/uploads';
const jsonParser = express.json({ limit: '1mb' });
const mcpJsonParser = express.json({ limit: `${Math.ceil(config.maxUploadMb * 1.4 * (config.maxImagesPerPost + config.maxFilesPerPost)) + 1}mb` });
app.use((req, res, next) => {
  if (req.path === UPLOAD_PATH) return next();
  return (req.path === '/mcp' ? mcpJsonParser : jsonParser)(req, res, next);
});

// ---------------------------------------------------------------- auth

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

// Brute-force brake: after too many invalid keys from one IP, refuse all credentials from it for a while.
const MAX_AUTH_FAILURES = 20;
const AUTH_BLOCK_MS = 15 * 60_000;
const authFailures = new Map(); // ip -> { n, reset }

function isBlocked(ip) {
  const f = authFailures.get(ip);
  return !!f && f.n >= MAX_AUTH_FAILURES && Date.now() < f.reset;
}

function recordFailure(ip) {
  let f = authFailures.get(ip);
  if (!f || Date.now() >= f.reset) f = { n: 0, reset: Date.now() + AUTH_BLOCK_MS };
  f.n++;
  authFailures.set(ip, f);
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, f] of authFailures) if (now >= f.reset) authFailures.delete(ip);
}, 60_000).unref();

const tooManyFailures = (res) => res.status(429).json({ error: 'Too many invalid keys from your address. Try again in 15 minutes.' });

/** Key from (in this order) Authorization: Bearer, X-API-Key, ?key=, or the session cookie. */
app.use((req, res, next) => {
  const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const explicit = bearer || req.headers['x-api-key'] || (typeof req.query.key === 'string' ? req.query.key : null);
  const session = explicit ? null : readCookie(req, COOKIE);
  if (explicit && isBlocked(req.ip)) return tooManyFailures(res);
  req.key = explicit ? forum.authenticate(explicit) : forum.authenticateSession(session);
  // Only wrong keys count; an expired session cookie just means "log in again".
  if (explicit && !req.key) recordFailure(req.ip);
  req.viaCookie = !explicit && !!req.key;
  // First successful admin login: the initial key file is no longer needed.
  if (initialKeyPending && req.key?.is_admin) {
    initialKeyPending = false;
    rmSync(INITIAL_KEY_FILE, { force: true });
  }
  // Cookie-authenticated writes must be JSON (or, for uploads, carry the custom X-Filename header):
  // browsers can't send either cross-site without a CORS preflight, which we never allow.
  const csrfSafe = req.is('application/json') || (req.path === UPLOAD_PATH && req.get('x-filename'));
  if (req.viaCookie && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !csrfSafe) {
    return res.status(415).json({ error: 'Expected application/json.' });
  }
  next();
});

const requireKey = (req, res, next) => (req.key ? next() : res.status(401).json({ error: 'Not logged in. Provide your key.' }));
const requireAdmin = (req, res, next) => (req.key?.is_admin ? next() : res.status(403).json({ error: 'Admins only.' }));
const id = (req) => Number(req.params.id);

// ---------------------------------------------------------------- session

// The browser only ever stores a session token, never the key itself.
function setSessionCookie(res, key) {
  const token = forum.createSession(key);
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${config.secureCookies ? '; Secure' : ''}`);
}

app.post('/api/session', (req, res) => {
  if (isBlocked(req.ip)) return tooManyFailures(res);
  const key = forum.authenticate(String(req.body?.key ?? '').trim());
  if (!key) {
    recordFailure(req.ip);
    return res.status(401).json({ error: 'Unknown or revoked key.' });
  }
  setSessionCookie(res, key);
  res.json({ me: key });
});

app.delete('/api/session', (req, res) => {
  forum.deleteSession(readCookie(req, COOKIE));
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${config.secureCookies ? '; Secure' : ''}`);
  res.json({ ok: true });
});

// Replace your own key, e.g. if it may have leaked. All other sessions of this key end.
app.post('/api/me/rotate', requireKey, (req, res) => {
  const { key, token } = forum.rotateKey(req.key.id);
  if (req.viaCookie) setSessionCookie(res, key);
  res.json({ key, token });
});

app.get('/api/me', requireKey, (req, res) => res.json({
  me: req.key,
  site: {
    name: config.siteName,
    url: publicUrl(req),
    limits: {
      max_images: config.maxImagesPerPost,
      max_files: config.maxFilesPerPost,
      max_upload_mb: config.maxUploadMb,
      retention_days: config.attachmentRetentionDays,
    },
  },
}));

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

// Upload one file as the raw request body (filename in X-Filename, URL-encoded).
// Returns an id to pass in `attachments` when posting the message.
app.post(UPLOAD_PATH, requireKey, express.raw({ type: () => true, limit: `${config.maxUploadMb}mb` }), (req, res) => {
  const filename = decodeURIComponent(req.get('x-filename') || req.query.filename || 'file');
  res.status(201).json({ attachment: attachments.saveUpload(req.key, { data: req.body, filename, mime: req.get('content-type') }) });
});

app.get('/api/attachments/:id', requireKey, (req, res) => {
  const row = forum.getAttachment(req.key, req.params.id);
  const inline = row.kind === 'image' && req.query.download === undefined;
  res.set({
    'Content-Type': inline ? row.mime : 'application/octet-stream',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; sandbox",
    'Cache-Control': 'private, max-age=86400',
  });
  res.sendFile(attachments.attachmentPath(row));
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
  if (err.type === 'entity.too.large') return res.status(413).json({ error: `Request too large (files: max ${config.maxUploadMb} MB each).` });
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

// Remove expired attachments now and every 10 minutes.
attachments.sweep();
setInterval(() => {
  try {
    attachments.sweep();
  } catch (err) {
    console.error('Attachment cleanup failed:', err);
  }
}, 10 * 60_000).unref();

app.listen(config.port, config.host, () => {
  console.log(`${config.siteName} listening on http://${config.host}:${config.port}${config.publicUrl ? ` (public: ${config.publicUrl})` : ''}`);
});
