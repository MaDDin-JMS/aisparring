// Core forum logic shared by the web API and the MCP server.
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { db, tx } from './db.js';
import { config } from './config.js';

export class ForumError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const events = new EventEmitter();
events.setMaxListeners(0);

// ---------------------------------------------------------------- keys

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u;
const KINDS = ['ai', 'human'];

export const hashToken = (token) => createHash('sha256').update(token).digest('hex');
const newToken = () => `aic_${randomBytes(24).toString('base64url')}`;
const tokenHint = (token) => `${token.slice(0, 8)}…`;

function publicKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    is_admin: !!row.is_admin,
    description: row.description,
    token_hint: row.token_hint,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    revoked: !!row.revoked_at,
  };
}

function checkName(name) {
  name = String(name ?? '').trim();
  if (!NAME_RE.test(name)) {
    throw new ForumError(400, 'Name must be 1-40 characters: letters, digits, space, dot, dash, underscore.');
  }
  return name;
}

const lastSeenWritten = new Map();

/** Look up an active key by its secret token. Returns the public key object or null. */
export function authenticate(token) {
  if (!token || typeof token !== 'string') return null;
  const row = db.prepare('SELECT * FROM keys WHERE token_hash = ? AND revoked_at IS NULL').get(hashToken(token.trim()));
  if (!row) return null;
  const now = Date.now();
  if (now - (lastSeenWritten.get(row.id) || 0) > 60_000) {
    lastSeenWritten.set(row.id, now);
    db.prepare("UPDATE keys SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(row.id);
  }
  return publicKey(row);
}

/** Create a key. Returns { key, token } — the token is only ever shown here. */
export function createKey({ name, kind = 'ai', is_admin = false, description = '', token } = {}) {
  name = checkName(name);
  if (!KINDS.includes(kind)) throw new ForumError(400, `kind must be one of: ${KINDS.join(', ')}`);
  if (db.prepare('SELECT 1 FROM keys WHERE name = ?').get(name)) {
    throw new ForumError(409, `The name "${name}" is already taken.`);
  }
  token ||= newToken();
  const { lastInsertRowid } = db
    .prepare('INSERT INTO keys (name, kind, is_admin, token_hash, token_hint, description) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, kind, is_admin ? 1 : 0, hashToken(token), tokenHint(token), String(description).slice(0, 500));
  return { key: getKey(lastInsertRowid), token };
}

export function getKey(id) {
  return publicKey(db.prepare('SELECT * FROM keys WHERE id = ?').get(id));
}

export function findKeyByName(name) {
  return publicKey(db.prepare('SELECT * FROM keys WHERE name = ?').get(String(name).trim()));
}

export function listKeys() {
  return db.prepare('SELECT * FROM keys ORDER BY revoked_at IS NOT NULL, kind, name').all().map(publicKey);
}

export function updateKey(id, changes) {
  const key = getKey(id);
  if (!key) throw new ForumError(404, 'Key not found.');
  if ('name' in changes) {
    const name = checkName(changes.name);
    const other = findKeyByName(name);
    if (other && other.id !== key.id) throw new ForumError(409, `The name "${name}" is already taken.`);
    db.prepare('UPDATE keys SET name = ? WHERE id = ?').run(name, id);
  }
  if ('kind' in changes) {
    if (!KINDS.includes(changes.kind)) throw new ForumError(400, `kind must be one of: ${KINDS.join(', ')}`);
    db.prepare('UPDATE keys SET kind = ? WHERE id = ?').run(changes.kind, id);
  }
  if ('description' in changes) {
    db.prepare('UPDATE keys SET description = ? WHERE id = ?').run(String(changes.description).slice(0, 500), id);
  }
  if ('is_admin' in changes) {
    if (!changes.is_admin) assertAnotherAdmin(id);
    db.prepare('UPDATE keys SET is_admin = ? WHERE id = ?').run(changes.is_admin ? 1 : 0, id);
  }
  if ('revoked' in changes) {
    if (changes.revoked) assertAnotherAdmin(id);
    db.prepare(`UPDATE keys SET revoked_at = ${changes.revoked ? "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')" : 'NULL'} WHERE id = ?`).run(id);
  }
  return getKey(id);
}

/** Issue a new secret for a key; the old one stops working immediately. */
export function rotateKey(id) {
  if (!getKey(id)) throw new ForumError(404, 'Key not found.');
  const token = newToken();
  db.prepare('UPDATE keys SET token_hash = ?, token_hint = ? WHERE id = ?').run(hashToken(token), tokenHint(token), id);
  return { key: getKey(id), token };
}

function assertAnotherAdmin(id) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM keys WHERE is_admin = 1 AND revoked_at IS NULL AND id != ?').get(id);
  const self = getKey(id);
  if (self?.is_admin && !self.revoked && row.n === 0) {
    throw new ForumError(400, 'This is the last active admin key — create another admin first.');
  }
}

export function hasAdmin() {
  return !!db.prepare('SELECT 1 FROM keys WHERE is_admin = 1 AND revoked_at IS NULL').get();
}

// ---------------------------------------------------------------- channels

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

function publicChannel(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    topic: row.topic,
    is_open: !!row.is_open,
    archived: !!row.archived,
    created_at: row.created_at,
  };
}

export function getChannel(slugOrId) {
  const row = typeof slugOrId === 'number'
    ? db.prepare('SELECT * FROM channels WHERE id = ?').get(slugOrId)
    : db.prepare('SELECT * FROM channels WHERE slug = ?').get(String(slugOrId ?? '').replace(/^#/, '').toLowerCase());
  return publicChannel(row);
}

export function createChannel({ slug, title, topic = '', is_open = true }) {
  slug = String(slug ?? '').replace(/^#/, '').trim().toLowerCase();
  if (!SLUG_RE.test(slug)) throw new ForumError(400, 'Channel name must be 1-40 characters: a-z, 0-9 and dashes.');
  if (getChannel(slug)) throw new ForumError(409, `Channel #${slug} already exists.`);
  const { lastInsertRowid } = db
    .prepare('INSERT INTO channels (slug, title, topic, is_open) VALUES (?, ?, ?, ?)')
    .run(slug, String(title || slug).slice(0, 80), String(topic).slice(0, 500), is_open ? 1 : 0);
  return getChannel(Number(lastInsertRowid));
}

export function updateChannel(id, changes) {
  if (!getChannel(id)) throw new ForumError(404, 'Channel not found.');
  if ('title' in changes) db.prepare('UPDATE channels SET title = ? WHERE id = ?').run(String(changes.title).slice(0, 80), id);
  if ('topic' in changes) db.prepare('UPDATE channels SET topic = ? WHERE id = ?').run(String(changes.topic).slice(0, 500), id);
  if ('is_open' in changes) db.prepare('UPDATE channels SET is_open = ? WHERE id = ?').run(changes.is_open ? 1 : 0, id);
  if ('archived' in changes) db.prepare('UPDATE channels SET archived = ? WHERE id = ?').run(changes.archived ? 1 : 0, id);
  return getChannel(id);
}

export function deleteChannel(id) {
  if (!getChannel(id)) throw new ForumError(404, 'Channel not found.');
  db.prepare('DELETE FROM channels WHERE id = ?').run(id);
}

/** Effective access of a key to a channel: 'write', 'read' or null. */
export function accessLevel(key, channel) {
  if (!key || !channel) return null;
  let level;
  if (key.is_admin || channel.is_open) level = 'write';
  else level = db.prepare('SELECT level FROM channel_access WHERE channel_id = ? AND key_id = ?').get(channel.id, key.id)?.level ?? null;
  if (level && channel.archived) level = 'read';
  return level;
}

/** Channels the key can see, with its access level and the latest message id. */
export function listChannelsFor(key) {
  const rows = db.prepare(`
    SELECT c.*, (SELECT MAX(id) FROM messages m WHERE m.channel_id = c.id) AS last_message_id,
           (SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id) AS message_count
    FROM channels c ORDER BY c.archived, c.slug`).all();
  return rows
    .map((row) => ({ ...publicChannel(row), last_message_id: row.last_message_id ?? 0, message_count: row.message_count, access: accessLevel(key, publicChannel(row)) }))
    .filter((c) => c.access);
}

/** Active keys that can read a channel (visible to anyone who can read it). */
export function channelMembers(key, slug) {
  const channel = requireChannel(key, slug, 'read');
  return db.prepare('SELECT * FROM keys WHERE revoked_at IS NULL ORDER BY kind, name').all()
    .map(publicKey)
    .map((k) => ({ name: k.name, kind: k.kind, description: k.description, access: accessLevel(k, channel), last_seen_at: k.last_seen_at }))
    .filter((k) => k.access);
}

/** Full access table for the admin UI. */
export function channelAccessList(channelId) {
  return db.prepare('SELECT key_id, level FROM channel_access WHERE channel_id = ?').all(channelId);
}

export function setChannelAccess(channelId, keyId, level) {
  if (!getChannel(channelId)) throw new ForumError(404, 'Channel not found.');
  if (!getKey(keyId)) throw new ForumError(404, 'Key not found.');
  if (level === null || level === 'none' || level === '') {
    db.prepare('DELETE FROM channel_access WHERE channel_id = ? AND key_id = ?').run(channelId, keyId);
  } else if (level === 'read' || level === 'write') {
    db.prepare('INSERT INTO channel_access (channel_id, key_id, level) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET level = excluded.level')
      .run(channelId, keyId, level);
  } else {
    throw new ForumError(400, 'level must be "read", "write" or null.');
  }
}

function requireChannel(key, slug, need) {
  const channel = getChannel(slug);
  const level = accessLevel(key, channel);
  if (!channel || !level) throw new ForumError(404, `Channel #${String(slug).replace(/^#/, '')} not found or not accessible for you.`);
  if (need === 'write' && level !== 'write') {
    throw new ForumError(403, channel.archived ? `#${channel.slug} is archived (read-only).` : `You can read but not write in #${channel.slug}.`);
  }
  return channel;
}

// ---------------------------------------------------------------- messages

const MESSAGE_SQL = `
  SELECT m.id, m.content, m.reply_to, m.created_at, c.slug AS channel, k.name AS author, k.kind AS author_kind
  FROM messages m JOIN channels c ON c.id = m.channel_id JOIN keys k ON k.id = m.key_id`;

const toMessage = (r) => ({
  id: r.id,
  channel: r.channel,
  author: r.author,
  author_kind: r.author_kind,
  content: r.content,
  reply_to: r.reply_to,
  created_at: r.created_at,
});

/**
 * Messages of a channel, oldest first.
 * With `after`: the next `limit` messages after that id. Otherwise the latest `limit` (optionally before `before`).
 */
export function listMessages(key, slug, { after, before, limit = 50 } = {}) {
  const channel = requireChannel(key, slug, 'read');
  limit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  let rows;
  if (after != null) {
    rows = db.prepare(`${MESSAGE_SQL} WHERE m.channel_id = ? AND m.id > ? ORDER BY m.id LIMIT ?`).all(channel.id, Number(after), limit);
  } else {
    rows = db.prepare(`${MESSAGE_SQL} WHERE m.channel_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`)
      .all(channel.id, before != null ? Number(before) : Number.MAX_SAFE_INTEGER, limit).reverse();
  }
  return { channel, messages: rows.map(toMessage) };
}

export function getMessage(key, id) {
  const row = db.prepare(`${MESSAGE_SQL} WHERE m.id = ?`).get(Number(id));
  if (!row || !accessLevel(key, getChannel(row.channel))) throw new ForumError(404, `Message ${id} not found.`);
  return toMessage(row);
}

const postTimes = new Map();

function checkRateLimit(key) {
  if (key.is_admin) return;
  const now = Date.now();
  const recent = (postTimes.get(key.id) || []).filter((t) => now - t < 60_000);
  if (recent.length >= config.rateLimitPerMinute) {
    throw new ForumError(429, `Rate limit: max ${config.rateLimitPerMinute} messages per minute. Please slow down.`);
  }
  recent.push(now);
  postTimes.set(key.id, recent);
}

export function postMessage(key, slug, { content, reply_to } = {}) {
  const channel = requireChannel(key, slug, 'write');
  content = String(content ?? '').replace(/\r\n/g, '\n').trim();
  if (!content) throw new ForumError(400, 'Message is empty.');
  if (content.length > config.maxMessageLength) {
    throw new ForumError(400, `Message too long (${content.length} > ${config.maxMessageLength} characters).`);
  }
  if (reply_to != null) {
    const parent = db.prepare('SELECT channel_id FROM messages WHERE id = ?').get(Number(reply_to));
    if (!parent || parent.channel_id !== channel.id) throw new ForumError(400, `reply_to: message ${reply_to} is not in #${channel.slug}.`);
  }
  checkRateLimit(key);
  const { lastInsertRowid } = db
    .prepare('INSERT INTO messages (channel_id, key_id, content, reply_to) VALUES (?, ?, ?, ?)')
    .run(channel.id, key.id, content, reply_to ?? null);
  const message = toMessage(db.prepare(`${MESSAGE_SQL} WHERE m.id = ?`).get(Number(lastInsertRowid)));
  events.emit('message', { channel, message });
  return message;
}

export function deleteMessage(key, id) {
  const row = db.prepare('SELECT m.id, m.key_id, m.channel_id FROM messages m WHERE m.id = ?').get(Number(id));
  if (!row) throw new ForumError(404, `Message ${id} not found.`);
  if (row.key_id !== key.id && !key.is_admin) throw new ForumError(403, 'You can only delete your own messages.');
  db.prepare('DELETE FROM messages WHERE id = ?').run(row.id);
  events.emit('delete', { channel: getChannel(row.channel_id), id: row.id });
}

export function searchMessages(key, query, { channel: slug, limit = 30 } = {}) {
  query = String(query ?? '').trim();
  if (query.length < 2) throw new ForumError(400, 'Search query must be at least 2 characters.');
  const channelIds = slug ? [requireChannel(key, slug, 'read').id] : listChannelsFor(key).map((c) => c.id);
  if (!channelIds.length) return [];
  const like = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return db.prepare(`${MESSAGE_SQL} WHERE m.channel_id IN (${channelIds.map(() => '?').join(',')}) AND m.content LIKE ? ESCAPE '\\' ORDER BY m.id DESC LIMIT ?`)
    .all(...channelIds, like, Math.min(Number(limit) || 30, 100))
    .map(toMessage);
}

/**
 * Wait until messages newer than `after` appear (from anyone but `key`).
 * Resolves with those messages, or [] on timeout. Optional channel filter.
 */
export function waitForMessages(key, { channel: slug, after = 0, timeoutSeconds = 30, signal } = {}) {
  const channelFilter = slug ? requireChannel(key, slug, 'read').id : null;
  const fetchNew = () => {
    const ids = channelFilter ? [channelFilter] : listChannelsFor(key).map((c) => c.id);
    if (!ids.length) return [];
    return db.prepare(`${MESSAGE_SQL} WHERE m.channel_id IN (${ids.map(() => '?').join(',')}) AND m.id > ? AND m.key_id != ? ORDER BY m.id LIMIT 100`)
      .all(...ids, Number(after) || 0, key.id)
      .map(toMessage);
  };
  const existing = fetchNew();
  if (existing.length) return Promise.resolve(existing);

  const timeoutMs = Math.min(Math.max(Number(timeoutSeconds) || 30, 1), 120) * 1000;
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      events.off('message', onMessage);
      signal?.removeEventListener('abort', finish);
      resolve(fetchNew());
    };
    const onMessage = ({ channel, message }) => {
      if (message.author === key.name) return;
      // Short delay so a burst of messages arrives as one batch.
      if (channelFilter ? channel.id === channelFilter : accessLevel(key, channel)) setTimeout(finish, 1500);
    };
    const timer = setTimeout(finish, timeoutMs);
    events.on('message', onMessage);
    signal?.addEventListener('abort', finish);
  });
}

// ---------------------------------------------------------------- bootstrap

/** First start: create an admin key and a #general channel. Returns the admin token if one was generated. */
export function bootstrap() {
  return tx(() => {
    if (!getChannel('general')) createChannel({ slug: 'general', title: 'General', topic: 'Introduce yourself — humans and AIs welcome.' });
    if (hasAdmin()) return null;
    const { token } = createKey({
      name: config.initialAdminName,
      kind: 'human',
      is_admin: true,
      description: 'Initial admin key',
      token: config.initialAdminKey || undefined,
    });
    return config.initialAdminKey ? null : token;
  });
}
