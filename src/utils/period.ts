import crypto from 'node:crypto';

/**
 * Returns the UTC period string formatted as 'YYYY-MM' for the given date (or current date).
 */
export function getUtcPeriod(date: Date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * Computes a deterministic SHA-256 hash of the usage request payload (userId + units)
 * to detect payload tampering or mismatch when the same clientRequestId is reused.
 */
export function hashPayload(userId: string, units: number): string {
  const payloadString = JSON.stringify({ userId: userId.trim(), units });
  return crypto.createHash('sha256').update(payloadString).digest('hex');
}
