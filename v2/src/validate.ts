/** Input checks shared by the store and the platform adapters. */
import { fail } from './errors.ts';

export const MAX_TEXT = 65536;

export function text(value: unknown, name: string, max = MAX_TEXT): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) fail('INVALID_INPUT', 400, `${name} must be non-empty text up to ${max} characters`);
  return value as string;
}
export const optText = (value: unknown, name: string, max = MAX_TEXT) => value === undefined || value === null ? null : text(value, name, max);
