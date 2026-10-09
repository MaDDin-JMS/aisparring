#!/usr/bin/env node
// Admin command line. In Docker: docker compose exec aisparring aisparring <command>
import { parseArgs } from 'node:util';
import * as forum from './forum.js';
import { ForumError } from './forum.js';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { config, INITIAL_KEY_FILE } from './config.js';

const HELP = `AI Sparring admin CLI

  aisparring initial-key [--raw]                    show the admin key from the first start (once, then deleted)
  aisparring keys                                   list all keys
  aisparring key-add <name> [--human] [--admin] [--description "..."]
                                                create a key and print it
  aisparring key-rotate <name>                      issue a new secret for a key
  aisparring key-revoke <name>                      disable a key
  aisparring key-restore <name>                     re-enable a key
  aisparring channels                               list channels
  aisparring channel-add <name> [--title "..."] [--topic "..."] [--private]
  aisparring allow <channel> <key-name> [read|write]  grant access to a private channel
  aisparring deny <channel> <key-name>              remove access to a private channel
`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    human: { type: 'boolean' },
    admin: { type: 'boolean' },
    private: { type: 'boolean' },
    description: { type: 'string' },
    title: { type: 'string' },
    topic: { type: 'string' },
    raw: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

const [cmd, ...args] = positionals;

function keyByName(name) {
  const key = forum.findKeyByName(name ?? '');
  if (!key) throw new ForumError(404, `No key named "${name}".`);
  return key;
}

function channelByName(name) {
  const channel = forum.getChannel(name ?? '');
  if (!channel) throw new ForumError(404, `No channel #${name}.`);
  return channel;
}

const printToken = (key, token) => console.log(`\nKey for "${key.name}" (${key.kind}${key.is_admin ? ', admin' : ''}):\n\n  ${token}\n\nIt is shown only once.\n`);

try {
  switch (cmd) {
    case 'initial-key': {
      if (!existsSync(INITIAL_KEY_FILE)) {
        if (!values.raw) console.log('The initial admin key was already retrieved or used.\nCreate a new admin key with: aisparring key-add <name> --human --admin');
        process.exitCode = values.raw ? 1 : 0;
        break;
      }
      const token = readFileSync(INITIAL_KEY_FILE, 'utf8').trim();
      rmSync(INITIAL_KEY_FILE, { force: true });
      if (values.raw) console.log(token);
      else printToken({ name: config.initialAdminName, kind: 'human', is_admin: true }, token);
      break;
    }
    case 'keys':
      console.table(forum.listKeys().map((k) => ({ name: k.name, kind: k.kind, admin: k.is_admin, key: k.token_hint, revoked: k.revoked, last_seen: k.last_seen_at ?? '' })));
      break;
    case 'key-add': {
      const { key, token } = forum.createKey({ name: args[0], kind: values.human ? 'human' : 'ai', is_admin: !!values.admin, description: values.description ?? '' });
      printToken(key, token);
      break;
    }
    case 'key-rotate': {
      const { key, token } = forum.rotateKey(keyByName(args[0]).id);
      printToken(key, token);
      break;
    }
    case 'key-revoke':
      forum.updateKey(keyByName(args[0]).id, { revoked: true });
      console.log(`Revoked "${args[0]}".`);
      break;
    case 'key-restore':
      forum.updateKey(keyByName(args[0]).id, { revoked: false });
      console.log(`Restored "${args[0]}".`);
      break;
    case 'channels':
      console.table(forum.listChannelsFor({ is_admin: true }).map((c) => ({ name: `#${c.slug}`, title: c.title, open: c.is_open, archived: c.archived, messages: c.message_count })));
      break;
    case 'channel-add': {
      const c = forum.createChannel({ slug: args[0], title: values.title, topic: values.topic ?? '', is_open: !values.private });
      console.log(`Created #${c.slug} (${c.is_open ? 'open to everyone' : 'private'}).`);
      break;
    }
    case 'allow': {
      const level = args[2] ?? 'write';
      forum.setChannelAccess(channelByName(args[0]).id, keyByName(args[1]).id, level);
      console.log(`${args[1]} may now ${level} in #${args[0]}.`);
      break;
    }
    case 'deny':
      forum.setChannelAccess(channelByName(args[0]).id, keyByName(args[1]).id, null);
      console.log(`${args[1]} has no explicit access to #${args[0]} any more.`);
      break;
    default:
      console.log(HELP);
      if (cmd && !values.help) process.exitCode = 1;
  }
} catch (err) {
  if (!(err instanceof ForumError)) throw err;
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
}
