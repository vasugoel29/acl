import { ulid } from 'ulid';
import crypto from 'node:crypto';

export const newId = (prefix: string) => `${prefix}_${ulid()}`;
export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

/** Constant-time comparison of two SHA-256 hex digests. */
export function safeCompareHex(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/** Escape HTML special characters to prevent reflected XSS. */
export function escapeHtml(str: unknown): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Escape a CSV field and neutralize spreadsheet formula injection (=, +, -, @, \t, \r).
 */
export function escapeCsvCell(val: unknown): string {
  if (val === null || val === undefined) return '';
  let s = String(val);
  // Neutralize CSV formula injection when cell starts with formula trigger characters
  // (excluding plain negative numbers like -12)
  if (/^[=+\-@\t\r]/.test(s) && !/^-\d+(\.\d+)?$/.test(s)) {
    s = `'${s}`;
  }
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
