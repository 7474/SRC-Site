import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractEntry, findEntry, inspect, readEntries, type RangeReader } from '../src/lib/zip';

// サンドボックス（sandbox/README.md）の zip が、投稿の検査に通ること
describe('サンドボックス', () => {
  const out = mkdtempSync(join(tmpdir(), 'sandbox-'));
  execFileSync('python3', ['-I', 'scripts/make-sandbox.py', out]);
  const reader = (name: string): RangeReader => {
    const bytes = new Uint8Array(readFileSync(join(out, name)));
    return { size: bytes.length, read: async (o, l) => bytes.subarray(o, o + l) };
  };
  const text = async (zip: string, path: string) => {
    const r = reader(zip);
    return new TextDecoder().decode(await extractEntry(r, findEntry(await readEntries(r), path)!));
  };

  it('シナリオ: root と最初の .eve が決まり、画像・音は入っていない（パックから読む）', async () => {
    const entries = await readEntries(reader('sandbox-scenario.zip'));
    expect(inspect(entries)).toMatchObject({ ok: true, root: 'サンドボックス', eve: 'サンドボックス.eve' });
    expect(entries.some(e => /\.(bmp|mid|wav)$/i.test(e.name))).toBe(false);
    // インターミッションのコマンド（動作確認のメニューは make-sandbox.py が作る）と、次のステージ（Continue）のイベントがある
    const eve = readFileSync('sandbox/scenario/サンドボックス/サンドボックス.eve', 'utf8');
    const targets = [...eve.matchAll(/^(?:IntermissionCommand \S+|Continue) (\S+\.eve)$/gm)].map(m => m[1].replace(/\\/g, '/'));
    expect(targets).toEqual(['Lib/about.eve', 'Lib/動作確認.eve', 'ステージ/おわり.eve']);
    for (const t of targets) {
      expect(entries.some(e => e.name === `サンドボックス/${t}`), t).toBe(true);
    }
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

  it('動作確認: すべての確認がインターミッションのメニューと一覧に出て、ステージと手順がある', async () => {
    const entries = await readEntries(reader('sandbox-scenario.zip'));
    const names = entries.map(e => e.name);
    const checks = readdirSync('sandbox/checks').filter(f => f.endsWith('.eve'));
    expect(checks.length).toBeGreaterThan(0);
    const menu = await text('sandbox-scenario.zip', 'サンドボックス/Lib/動作確認.eve');
    const list = await text('sandbox-scenario.zip', 'サンドボックス/確認一覧.md');
    for (const f of checks) {
      expect(names, f).toContain(`サンドボックス/ステージ/確認/${f}`);
      expect(menu, f).toContain(`Require ステージ\\確認\\${f}`);
      const title = /^# 題: (.+)$/m.exec(readFileSync(join('sandbox/checks', f), 'utf8'))![1];
      expect(list, f).toContain(title);
      expect(existsSync(join('sandbox/checks', f.replace(/\.eve$/, '.play'))), `${f} の .play`).toBe(true);
      // Call 後片付け の行き先は確認のファイルの中にある（シナリオを上げるときの確認はファイルごとにラベルを探す）
      const stage = await text('sandbox-scenario.zip', `サンドボックス/ステージ/確認/${f}`);
      expect(stage.match(/^後片付け:$/gm), f).toHaveLength(1);
    }
    // Require したときにラベルが重ならない
    expect(menu).not.toMatch(/^後片付け:$/m);
    expect(names).toContain('サンドボックス/Data/確認/robot.txt');
    expect(readFileSync('sandbox/scenario/サンドボックス/サンドボックス.eve', 'utf8')).toMatch(/^IntermissionCommand 動作確認 Lib\\動作確認\.eve$/m);
  });

  it('動作確認の見出しが足りなければ zip を作らない', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-bad-'));
    // 本物の sandbox/ を写し、見出しの欠けた確認を足す
    cpSync('sandbox', join(dir, 'sandbox'), { recursive: true });
    cpSync('scripts', join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'sandbox/checks/2026-01-01-broken.eve'), '# 題: 見出しが足りない\n確認:\nContinue\n');
    expect(() => execFileSync('python3', ['-I', join(dir, 'scripts/make-sandbox.py'), join(dir, 'out')], { stdio: 'pipe' })).toThrow(/見出しが足りない/);
  });

  it('生成AIで作ったテスト用であることを、説明の最初に書いている', () => {
    for (const f of ['sandbox/README.md', 'sandbox/scenario/サンドボックス/README.md', 'sandbox/pack/README.txt', 'sandbox/checks/README.md']) {
      expect(readFileSync(f, 'utf8').split('\n').slice(0, 5).join('\n')).toMatch(/生成AIで作ったテスト用/);
    }
  });
});
