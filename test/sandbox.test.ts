import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect, readEntries, type RangeReader } from '../src/lib/zip';

// サンドボックス（sandbox/README.md）の zip が、投稿の検査に通ること
describe('サンドボックス', () => {
  const out = mkdtempSync(join(tmpdir(), 'sandbox-'));
  execFileSync('python3', ['-I', 'scripts/make-sandbox.py', out]);
  const reader = (name: string): RangeReader => {
    const bytes = new Uint8Array(readFileSync(join(out, name)));
    return { size: bytes.length, read: async (o, l) => bytes.subarray(o, o + l) };
  };

  it('シナリオ: root と最初の .eve が決まり、画像・音は入っていない（パックから読む）', async () => {
    const entries = await readEntries(reader('sandbox-scenario.zip'));
    expect(inspect(entries)).toMatchObject({ ok: true, root: 'サンドボックス', eve: 'サンドボックス.eve' });
    expect(entries.some(e => /\.(bmp|mid|wav)$/i.test(e.name))).toBe(false);
  });

  it('パック: 素材の投稿として通り、データが参照する画像・音がある', async () => {
    const entries = await readEntries(reader('sandbox-pack.zip'));
    const result = inspect(entries, 'resource');
    expect(result).toMatchObject({ ok: true, root: null });
    const names = entries.map(e => e.name);
    const data = ['pilot.txt', 'robot.txt'].map(f => readFileSync(join('sandbox/scenario/サンドボックス/Data/サンドボックス', f), 'utf8')).join('\n');
    for (const ref of new Set(data.match(/Sandbox_\w+\.bmp|sandbox_\w+\.mid/g))) {
      expect(names.some(n => n.toLowerCase().endsWith('/' + ref.toLowerCase())), ref).toBe(true);
    }
    const eve = readFileSync('sandbox/scenario/サンドボックス/サンドボックス.eve', 'utf8');
    for (const ref of new Set(eve.match(/sandbox_\w+\.(mid|wav)/g))) {
      expect(names.some(n => n.toLowerCase().endsWith('/' + ref.toLowerCase())), ref).toBe(true);
    }
  });

  it('生成AIで作ったテスト用であることを、説明の最初に書いている', () => {
    for (const f of ['sandbox/README.md', 'sandbox/scenario/サンドボックス/README.md', 'sandbox/pack/README.txt']) {
      expect(readFileSync(f, 'utf8').split('\n').slice(0, 5).join('\n')).toMatch(/生成AIで作ったテスト用/);
    }
  });
});
