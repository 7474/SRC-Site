import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// public/upload.js の SHA-256 を Node の crypto と比べる
const script = readFileSync(new URL('../public/upload.js', import.meta.url), 'utf8');
const window: any = {};
runInNewContext(script, { window, document: { getElementById: () => null }, Uint8Array, Uint32Array, Math });

describe('upload.js の SHA-256', () => {
  it.each([0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 100_000])('%d バイト', size => {
    const data = new Uint8Array(size).map((_, i) => (i * 31 + 7) & 0xff);
    // 境界をまたぐよう、細かく分けて渡す
    expect(window.srcSiteSha256(data)).toBe(createHash('sha256').update(data).digest('hex'));
  });
});
