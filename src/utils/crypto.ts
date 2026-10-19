import crypto from 'node:crypto';

const API_KEY_PREFIX = 'umq_live_';

/**
 * Generates a cryptographically secure random API key with a recognizable prefix.
 * e.g., "umq_live_4f8a...32bytes"
 */
export function generateApiKey(): string {
  const randomBytes = crypto.randomBytes(24).toString('hex');
  return `${API_KEY_PREFIX}${randomBytes}`;
}

/**
 * Computes a SHA-256 hash of the plain-text API key for safe storage.
 */
export function hashApiKey(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey.trim()).digest('hex');
}
