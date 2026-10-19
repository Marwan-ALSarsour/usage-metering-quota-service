const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Strictly validates YYYY-MM where YYYY is 1900-2099 and MM is 01-12 without whitespace
const PERIOD_REGEX = /^(?:19|20)\d{2}-(?:0[1-9]|1[0-2])$/;

export function isNonEmptyString(val: unknown): val is string {
  return typeof val === 'string' && val.trim().length > 0;
}

export function isPositiveInteger(val: unknown): val is number {
  return typeof val === 'number' && Number.isInteger(val) && val > 0;
}

export function isValidUuid(val: unknown): val is string {
  return typeof val === 'string' && UUID_REGEX.test(val);
}

export function isValidScope(val: unknown): val is 'ACCOUNT' | 'USER' {
  return val === 'ACCOUNT' || val === 'USER';
}

export function isValidPeriod(val: unknown): val is string {
  return typeof val === 'string' && PERIOD_REGEX.test(val);
}

export function isValidUsageStatus(val: unknown): val is 'ACCEPTED' | 'REJECTED' {
  return val === 'ACCEPTED' || val === 'REJECTED';
}
