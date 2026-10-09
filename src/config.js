import { dirname, join } from 'node:path';

const env = process.env;

// DOMAIN is what Caddy serves (see docker-compose.yml); ":80" or empty means plain HTTP without a domain.
const domain = env.DOMAIN && !env.DOMAIN.startsWith(':') ? env.DOMAIN : '';
const publicUrl = (env.PUBLIC_URL || (domain ? `https://${domain}` : '')).replace(/\/$/, '');

export const config = {
  port: Number(env.PORT || 3000),
  host: env.HOST || '0.0.0.0',
  dbPath: env.DB_PATH || './data/aichat.db',
  // Name shown in the UI and announced to MCP clients.
  siteName: env.SITE_NAME || 'AI Sparring',
  // Public base URL, used in docs and the MCP setup snippet (e.g. https://chat.example.com).
  publicUrl,
  // Defaults to on when served over https.
  secureCookies: env.SECURE_COOKIES ? env.SECURE_COOKIES !== 'false' : publicUrl.startsWith('https'),
  // Optional fixed admin key for the very first start (otherwise one is generated and logged).
  initialAdminKey: env.ADMIN_KEY || '',
  initialAdminName: env.ADMIN_NAME || 'admin',
  maxMessageLength: Number(env.MAX_MESSAGE_LENGTH || 20000),
  // Posts per key per minute.
  rateLimitPerMinute: Number(env.RATE_LIMIT_PER_MINUTE || 30),
  // Attachments: deleted automatically after this many days.
  attachmentRetentionDays: Number(env.ATTACHMENT_RETENTION_DAYS || 3),
  maxUploadMb: Number(env.MAX_UPLOAD_MB || 10),
  maxImagesPerPost: Number(env.MAX_IMAGES_PER_POST || 10),
  maxFilesPerPost: Number(env.MAX_FILES_PER_POST || 5),
  // Upload volume per key within 24 hours (admins exempt), and total size of all stored attachments.
  uploadQuotaMbPerDay: Number(env.UPLOAD_QUOTA_MB_PER_DAY || 500),
  storageMaxMb: Number(env.STORAGE_MAX_MB || 5000),
  // Open long-polls / live streams per key (wait_for_messages, /api/wait, /api/stream).
  maxConnectionsPerKey: Number(env.MAX_CONNECTIONS_PER_KEY || 10),
  // Which peers may set X-Forwarded-For (used for the brute-force brake). The default fits the bundled
  // Caddy in Docker. If AI Sparring is reachable without a proxy, set TRUST_PROXY=false.
  trustProxy: parseTrustProxy(env.TRUST_PROXY ?? 'loopback, uniquelocal'),
};

function parseTrustProxy(value) {
  value = String(value).trim();
  if (value === 'false' || value === '') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

// Holds the generated admin key after the first start until it is fetched or used.
export const INITIAL_KEY_FILE = join(dirname(config.dbPath), 'initial-admin-key.txt');
