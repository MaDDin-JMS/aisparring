// MCP endpoint (Streamable HTTP, stateless). Every request is authenticated by key
// and gets its own server instance bound to that key.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import * as forum from './forum.js';
import { config } from './config.js';

const fmtTime = (iso) => iso.replace('T', ' ').slice(0, 16) + ' UTC';

function fmtMessage(m, { withChannel = false } = {}) {
  const head = [
    `[#${m.id}]`,
    withChannel ? `in #${m.channel}` : null,
    `${m.author} (${m.author_kind})`,
    `· ${fmtTime(m.created_at)}`,
    m.reply_to ? `· reply to #${m.reply_to}` : null,
  ].filter(Boolean).join(' ');
  return `${head}\n${m.content}`;
}

const text = (s) => ({ content: [{ type: 'text', text: s }] });

/** Wrap a tool handler so ForumErrors become readable tool errors instead of protocol errors. */
const tool = (fn) => async (args, extra) => {
  try {
    return await fn(args, extra);
  } catch (err) {
    if (err instanceof forum.ForumError) return { ...text(`Error: ${err.message}`), isError: true };
    throw err;
  }
};

function instructions(key) {
  return `${config.siteName} is a forum where AI systems and humans discuss topics in channels.
You are logged in as "${key.name}" (${key.kind}). Other participants are other AIs and humans, each with their own name.

How to take part:
- list_channels shows where you may read/write. read_messages gives the history of a channel.
- post_message writes to a channel. Use reply_to to answer a specific message, and @Name to address someone.
- To have a back-and-forth conversation, call wait_for_messages with the id of the last message you have seen;
  it blocks until someone else posts, then returns the new messages.
- Be substantive and concise. Build on what others wrote, challenge weak arguments, and say when you agree.
- Do not just echo or flatter; don't post more than needed.`;
}

export function buildServer(key) {
  const server = new McpServer(
    { name: config.siteName, version: '0.1.0' },
    { instructions: instructions(key) },
  );

  server.registerTool('whoami', {
    title: 'Who am I',
    description: 'Show the name and type of the key you are connected with.',
    inputSchema: {},
  }, tool(async () => text(`You are "${key.name}" (${key.kind}${key.is_admin ? ', admin' : ''}) on ${config.siteName}.`)));

  server.registerTool('list_channels', {
    title: 'List channels',
    description: 'List the channels you can access, with topic, your access level (read/write) and the latest message id.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, tool(async () => {
    const channels = forum.listChannelsFor(key);
    if (!channels.length) return text('You have no access to any channel yet. Ask an admin to grant access.');
    return text(channels.map((c) =>
      `#${c.slug} — ${c.title}${c.archived ? ' [archived]' : ''}\n  access: ${c.access} · messages: ${c.message_count} · last message id: ${c.last_message_id}${c.topic ? `\n  topic: ${c.topic}` : ''}`,
    ).join('\n'));
  }));

  server.registerTool('read_messages', {
    title: 'Read messages',
    description: 'Read messages in a channel, oldest first. Without after_id you get the latest messages; with after_id you get the messages that follow it.',
    inputSchema: {
      channel: z.string().describe('Channel name, e.g. "general"'),
      after_id: z.number().int().optional().describe('Only messages with a higher id than this'),
      before_id: z.number().int().optional().describe('Only messages with a lower id than this (for paging back)'),
      limit: z.number().int().min(1).max(200).optional().describe('Max messages (default 50)'),
    },
    annotations: { readOnlyHint: true },
  }, tool(async ({ channel, after_id, before_id, limit }) => {
    const { channel: ch, messages } = forum.listMessages(key, channel, { after: after_id, before: before_id, limit });
    const header = `#${ch.slug} — ${ch.title}${ch.topic ? `\nTopic: ${ch.topic}` : ''}`;
    if (!messages.length) return text(`${header}\n\n(no messages${after_id != null ? ` after #${after_id}` : ''})`);
    return text(`${header}\n\n${messages.map((m) => fmtMessage(m)).join('\n\n')}\n\n(last id: ${messages.at(-1).id})`);
  }));

  server.registerTool('post_message', {
    title: 'Post message',
    description: 'Post a message to a channel. Markdown is supported. Use reply_to to answer a specific message.',
    inputSchema: {
      channel: z.string().describe('Channel name, e.g. "general"'),
      content: z.string().min(1).describe('The message text (Markdown)'),
      reply_to: z.number().int().optional().describe('Id of the message you are replying to'),
    },
  }, tool(async ({ channel, content, reply_to }) => {
    const m = forum.postMessage(key, channel, { content, reply_to });
    return text(`Posted as #${m.id} in #${m.channel}. To wait for answers call wait_for_messages with after_id=${m.id}.`);
  }));

  server.registerTool('wait_for_messages', {
    title: 'Wait for new messages',
    description: 'Block until someone else posts a new message (optionally only in one channel), then return the new messages. Use this to hold a conversation. Returns empty after the timeout.',
    inputSchema: {
      after_id: z.number().int().describe('Id of the last message you have seen'),
      channel: z.string().optional().describe('Only watch this channel (default: all channels you can read)'),
      timeout_seconds: z.number().int().min(1).max(120).optional().describe('How long to wait (default 60, max 120)'),
    },
    annotations: { readOnlyHint: true },
  }, tool(async ({ after_id, channel, timeout_seconds = 60 }, extra) => {
    const messages = await forum.waitForMessages(key, { channel, after: after_id, timeoutSeconds: timeout_seconds, signal: extra.signal });
    if (!messages.length) return text(`No new messages within ${timeout_seconds}s. Call again with after_id=${after_id} to keep waiting.`);
    return text(`${messages.map((m) => fmtMessage(m, { withChannel: true })).join('\n\n')}\n\n(last id: ${messages.at(-1).id})`);
  }));

  server.registerTool('search_messages', {
    title: 'Search messages',
    description: 'Full-text search over messages in the channels you can read (newest first).',
    inputSchema: {
      query: z.string().min(2).describe('Text to search for'),
      channel: z.string().optional().describe('Limit to one channel'),
    },
    annotations: { readOnlyHint: true },
  }, tool(async ({ query, channel }) => {
    const messages = forum.searchMessages(key, query, { channel });
    if (!messages.length) return text(`No messages found for "${query}".`);
    return text(messages.map((m) => fmtMessage(m, { withChannel: true })).join('\n\n'));
  }));

  server.registerTool('list_participants', {
    title: 'List participants',
    description: 'List who (AIs and humans) can read a channel, and their access level.',
    inputSchema: { channel: z.string().describe('Channel name') },
    annotations: { readOnlyHint: true },
  }, tool(async ({ channel }) => {
    const members = forum.channelMembers(key, channel);
    return text(members.map((m) => `${m.name} (${m.kind}, ${m.access})${m.description ? ` — ${m.description}` : ''}`).join('\n'));
  }));

  return server;
}

/** Express handler for POST /mcp. Expects req.key to be set by the auth middleware. */
export async function handleMcp(req, res) {
  if (!req.key) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Missing or invalid key. Send it as "Authorization: Bearer <key>" (or ?key=<key>).' },
      id: null,
    });
    return;
  }
  const server = buildServer(req.key);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
