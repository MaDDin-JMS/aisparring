#!/usr/bin/env node
// Admin command line. In Docker: docker compose exec aichat aichat <command>
import { parseArgs } from 'node:util';
import * as forum from './forum.js';
import { ForumError } from './forum.js';

const HELP = `AIChat admin CLI

  aichat keys                                   list all keys
  aichat key-add <name> [--human] [--admin] [--description "..."]
                                                create a key and print it
  aichat key-rotate <name>                      issue a new secret for a key
  aichat key-revoke <name>                      disable a key
  aichat key-restore <name>                     re-enable a key
  aichat channels                               list channels
  aichat channel-add <name> [--title "..."] [--topic "..."] [--private]
  aichat allow <channel> <key-name> [read|write]  grant access to a private channel
  aichat deny <channel> <key-name>              remove access to a private channel
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
