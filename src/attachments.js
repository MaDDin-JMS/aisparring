// File storage for message attachments. Files expire after config.attachmentRetentionDays.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { db } from './db.js';
import { config } from './config.js';
import { ForumError } from './errors.js';
import { assertNoSecrets } from './secrets.js';

export const UPLOAD_DIR = join(dirname(config.dbPath), 'uploads');
mkdirSync(UPLOAD_DIR, { recursive: true });

// Uploads not attached to a message within this time are discarded.
const PENDING_TTL_MS = 60 * 60 * 1000;

// Only these are shown inline as images; everything else (incl. SVG) is a download.
const IMAGE_SIGNATURES = [
  ['image/png', (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/gif', (b) => b.subarray(0, 4).toString('latin1') === 'GIF8'],
  ['image/webp', (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
];


const filePath = (id) => join(UPLOAD_DIR, id);

function cleanFilename(name) {
  name = basename(String(name || 'file')).replace(/[\u0000-\u001f\u007f"\\/]/g, '_').trim();
  return (name || 'file').slice(0, 120);
}

function cleanMime(mime) {
  mime = String(mime || '').split(';')[0].trim().toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime) ? mime : 'application/octet-stream';
}

export function publicAttachment(row, base = '') {
  return {
    id: row.id,
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    kind: row.kind,
    url: `${base}/api/attachments/${row.id}`,
    expires_at: row.expires_at,
    expired: !!row.purged,
  };
}

/** Store an uploaded file for `key`. It must be attached to a post within an hour. */
export function saveUpload(key, { data, filename, mime }) {
  if (!Buffer.isBuffer(data) || !data.length) throw new ForumError(400, 'The file is empty.');
  if (data.length > config.maxUploadMb * 1024 * 1024) throw new ForumError(413, `File too large (max ${config.maxUploadMb} MB).`);
  const pending = db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE key_id = ? AND message_id IS NULL').get(key.id).n;
  if (pending >= 2 * (config.maxImagesPerPost + config.maxFilesPerPost)) {
    throw new ForumError(429, 'Too many unsent uploads. Send your message first.');
  }
  assertNoSecrets(data.toString('latin1'), `File "${cleanFilename(filename)}"`);
  const image = IMAGE_SIGNATURES.find(([, test]) => test(data));
  const id = randomBytes(16).toString('base64url');
  const expires = new Date(Date.now() + config.attachmentRetentionDays * 86_400_000).toISOString();
  writeFileSync(filePath(id), data, { mode: 0o600 });
  db.prepare('INSERT INTO attachments (id, key_id, filename, mime, size, kind, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, key.id, cleanFilename(filename), image ? image[0] : cleanMime(mime), data.length, image ? 'image' : 'file', expires);
  return publicAttachment(db.prepare('SELECT * FROM attachments WHERE id = ?').get(id));
}

/** Link pending uploads of `key` to a message, enforcing the per-post limits. Call inside a transaction. */
export function attachToMessage(key, messageId, ids) {
  ids = [...new Set((ids || []).map(String))];
  if (!ids.length) return;
  const rows = ids.map((id) => db.prepare('SELECT * FROM attachments WHERE id = ?').get(id));
  rows.forEach((row, i) => {
    if (!row || row.key_id !== key.id || row.message_id !== null || row.purged) {
      throw new ForumError(400, `Attachment ${ids[i]} not found or already used — upload it again.`);
    }
  });
  const images = rows.filter((r) => r.kind === 'image').length;
  const files = rows.length - images;
  if (images > config.maxImagesPerPost) throw new ForumError(400, `Max ${config.maxImagesPerPost} images per post.`);
  if (files > config.maxFilesPerPost) throw new ForumError(400, `Max ${config.maxFilesPerPost} files per post.`);
  const stmt = db.prepare('UPDATE attachments SET message_id = ? WHERE id = ?');
  for (const id of ids) stmt.run(messageId, id);
}

/** Attachments for a list of message ids: Map<messageId, attachment[]>. */
export function attachmentsFor(messageIds, base = '') {
  const map = new Map();
  if (!messageIds.length) return map;
  const rows = db.prepare(`SELECT * FROM attachments WHERE message_id IN (${messageIds.map(() => '?').join(',')}) ORDER BY kind DESC, created_at`)
    .all(...messageIds);
  for (const row of rows) {
    if (!map.has(row.message_id)) map.set(row.message_id, []);
    map.get(row.message_id).push(publicAttachment(row, base));
  }
  return map;
}

export function getAttachmentRow(id) {
  return db.prepare('SELECT * FROM attachments WHERE id = ?').get(String(id));
}

export function readAttachment(row) {
  return readFileSync(filePath(row.id));
}

export const attachmentPath = (row) => filePath(row.id);

/** Delete expired files, stale pending uploads and files without a database row. */
export function sweep() {
  const now = new Date().toISOString();
  for (const row of db.prepare('SELECT id FROM attachments WHERE purged = 0 AND expires_at <= ?').all(now)) {
    rmSync(filePath(row.id), { force: true });
    db.prepare('UPDATE attachments SET purged = 1 WHERE id = ?').run(row.id);
  }
  const stale = new Date(Date.now() - PENDING_TTL_MS).toISOString();
  db.prepare('DELETE FROM attachments WHERE message_id IS NULL AND created_at <= ?').run(stale);
  const live = new Set(db.prepare('SELECT id FROM attachments WHERE purged = 0').all().map((r) => r.id));
  for (const name of readdirSync(UPLOAD_DIR)) {
    if (!live.has(name)) rmSync(filePath(name), { force: true });
  }
}

/** Drop uploads of `key` that were never attached (e.g. because posting failed). */
export function discardPending(key, ids) {
  for (const id of ids) {
    const row = db.prepare('SELECT * FROM attachments WHERE id = ? AND key_id = ? AND message_id IS NULL').get(id, key.id);
    if (!row) continue;
    db.prepare('DELETE FROM attachments WHERE id = ?').run(id);
    rmSync(filePath(id), { force: true });
  }
}
