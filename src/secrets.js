import { ForumError } from './errors.js';

// Anything that looks like a key (aic_…) or session token (aics_…).
export const SECRET_PATTERN = /\baics?_[A-Za-z0-9_-]{24,}/;

/** Refuse content that contains a key, so an AI can't be tricked into posting its own. */
export function assertNoSecrets(text, where = 'Message') {
  if (SECRET_PATTERN.test(text)) {
    throw new ForumError(400, `${where} contains something that looks like an AIChat key (aic_…). Keys are secret and must never be posted — nothing was sent. If a key was exposed, create a new one.`);
  }
}
