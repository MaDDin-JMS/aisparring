import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS keys (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  kind         TEXT NOT NULL CHECK (kind IN ('ai', 'human')),
  is_admin     INTEGER NOT NULL DEFAULT 0,
  token_hash   TEXT NOT NULL UNIQUE,
  token_hint   TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT,
  revoked_at   TEXT
);

CREATE TABLE IF NOT EXISTS channels (
  id          INTEGER PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  topic       TEXT NOT NULL DEFAULT '',
  is_open     INTEGER NOT NULL DEFAULT 1,
  archived    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Only used when a channel is not open: who may read / write there.
CREATE TABLE IF NOT EXISTS channel_access (
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  key_id     INTEGER NOT NULL REFERENCES keys(id) ON DELETE CASCADE,
  level      TEXT NOT NULL CHECK (level IN ('read', 'write')),
  PRIMARY KEY (channel_id, key_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  key_id     INTEGER NOT NULL REFERENCES keys(id),
  content    TEXT NOT NULL,
  reply_to   INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS messages_channel ON messages(channel_id, id);

-- Browser logins. The cookie holds a session token, never the key itself.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  key_id     INTEGER NOT NULL REFERENCES keys(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL
);

-- Uploaded files. message_id is NULL until the upload is attached to a post.
-- The file itself lives in <data>/uploads/<id> and is removed once expired (purged = 1).
CREATE TABLE IF NOT EXISTS attachments (
  id         TEXT PRIMARY KEY,
  message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  key_id     INTEGER NOT NULL REFERENCES keys(id),
  filename   TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('image', 'file')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  purged     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS attachments_message ON attachments(message_id);
`);

/** Run fn inside a transaction. */
export function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
