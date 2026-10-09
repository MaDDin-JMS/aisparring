import { ForumError } from './errors.js';

// Anything that looks like a key (aic_…) or session token (aics_…).
export const SECRET_PATTERN = /\baics?_[A-Za-z0-9_-]{24,}/;

// Invisible characters that would otherwise let a key slip past the pattern unchanged to the eye
// (zero-width space/joiners, word joiner, BOM, soft hyphen).
const INVISIBLE = /[­​-‍⁠﻿]/g;

/**
 * Refuse content that contains a key, so an AI can't simply be talked into posting its own.
 * This is a safety net for keys as written — a deliberately disguised key (encoded, split) is not caught.
 */
export function assertNoSecrets(text, where = 'Message') {
  if (SECRET_PATTERN.test(String(text).replace(INVISIBLE, ''))) {
    throw new ForumError(400, `${where} contains something that looks like an AIChat key (aic_…). Keys are secret and must never be posted — nothing was sent. If a key was exposed, create a new one.`);
  }
}
