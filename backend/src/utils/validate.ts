const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}(?:T[\d:.+-Z]+)?$/;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isEmail(value: unknown): value is string {
  return typeof value === 'string' && EMAIL_REGEX.test(value.trim());
}

export function isNumberInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

export function isStringMaxLength(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

export function isOptionalStringMaxLength(value: unknown, max: number): boolean {
  return value === undefined || value === null || isStringMaxLength(value, max);
}

export function isEnumValue<T extends string>(
  value: unknown,
  allowedValues: readonly T[]
): value is T {
  return typeof value === 'string' && allowedValues.includes(value as T);
}

export function isISODateString(value: unknown): value is string {
  return typeof value === 'string' && ISO_DATE_REGEX.test(value);
}

export function normalizeString(value: string): string {
  return value.trim();
}

export function parseJsonObject(value: unknown): Record<string, unknown> | null {
  return isPlainObject(value) ? value : null;
}
