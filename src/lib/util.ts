// 小さな道具

export const now = () => Date.now();

export function randomHex(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) {
    s += String.fromCharCode(b);
  }
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** HMAC-SHA256 で署名した値（Cookie に入れる短命の値に使う） */
export async function sign(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return value + '.' + base64url(new Uint8Array(mac));
}

export async function unsign(secret: string, signed: string): Promise<string | null> {
  const dot = signed.lastIndexOf('.');
  if (dot < 0) {
    return null;
  }
  const value = signed.slice(0, dot);
  const expected = await sign(secret, value);
  return timingSafeEqual(expected, signed) ? value : null;
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function formatSize(size: number): string {
  if (size >= 1024 * 1024 * 1024) {
    return (size / 1024 / 1024 / 1024).toFixed(1) + ' GB';
  }
  if (size >= 1024 * 1024) {
    return (size / 1024 / 1024).toFixed(1) + ' MB';
  }
  return Math.max(1, Math.round(size / 1024)) + ' KB';
}

export function formatDate(ms: number): string {
  const d = new Date(ms + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

export function parseJsonArray(text: string | null | undefined): string[] {
  try {
    const value = JSON.parse(text ?? '[]');
    return Array.isArray(value) ? value.filter(x => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** URL・SRC#Web の play に使う名前（英小文字・数字・-、3〜40 文字） */
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
/** 表示名（URL にも使う。英数字・_・-、3〜24 文字） */
export const HANDLE_PATTERN = /^[A-Za-z0-9_-]{3,24}$/;

export const RATINGS = ['general', 'r15', 'r18'] as const;
export type Rating = typeof RATINGS[number];
export const RATING_LABELS: Record<Rating, string> = { general: '全年齢', r15: 'R15', r18: 'R18' };
