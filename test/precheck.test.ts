import { describe, expect, it } from 'vitest';
import { precheck } from '../src/client/precheck';

// 最小の zip（格納・UTF-8 の印）を作る
function makeZip(files: Record<string, string>): Uint8Array {
  const enc = new TextEncoder();
  const local: number[] = [];
  const central: number[] = [];
  const u16 = (a: number[], v: number) => a.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (a: number[], v: number) => a.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  let count = 0;
  for (const [name, body] of Object.entries(files)) {
    const n = enc.encode(name);
    const b = enc.encode(body);
    const offset = local.length;
    u32(local, 0x04034b50); u16(local, 20); u16(local, 0x800); u16(local, 0); u32(local, 0); u32(local, 0);
    u32(local, b.length); u32(local, b.length); u16(local, n.length); u16(local, 0); local.push(...n, ...b);
    u32(central, 0x02014b50); u16(central, 20); u16(central, 20); u16(central, 0x800); u16(central, 0); u32(central, 0); u32(central, 0);
    u32(central, b.length); u32(central, b.length); u16(central, n.length); u16(central, 0); u16(central, 0); u16(central, 0); u16(central, 0);
    u32(central, 0); u32(central, offset); central.push(...n);
    count++;
  }
  const end: number[] = [];
  u32(end, 0x06054b50); u16(end, 0); u16(end, 0); u16(end, count); u16(end, count); u32(end, central.length); u32(end, local.length); u16(end, 0);
  return new Uint8Array([...local, ...central, ...end]);
}

describe('precheck（アップロードの前の検査）', () => {
  it('.eve のある zip は通す', async () => {
    const r = await precheck(new Blob([makeZip({ 'demo/デモ.eve': 'x', 'demo/Data/a.txt': 'y' })]));
    expect(r).toMatchObject({ ok: true, root: 'demo', files: 2 });
  });
  it('実行ファイルを含む zip は弾く', async () => {
    const r = await precheck(new Blob([makeZip({ 'demo/デモ.eve': 'x', 'demo/setup.exe': 'MZ' })]));
    expect(r.ok).toBe(false);
  });
  it('zip でなければ弾く', async () => {
    const r = await precheck(new Blob([new Uint8Array(100)]));
    expect(r.ok).toBe(false);
  });
});
