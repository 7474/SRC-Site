import { describe, expect, it } from 'vitest';
import { catalog, resolveRequires, type PackRow, type PlayableRow } from '../src/lib/catalog';

const pack = (id: string, is_default: number, priority: number, withdrawn = 0): PackRow => ({
  id, title: id, description: null, source_name: 's', source_url: null, license: 'l', is_default, priority, root: null,
  version: 'v1', r2_key: `packs/${id}/v1.zip`, size: 1, withdrawn,
});

describe('resolveRequires', () => {
  const packs = [pack('basic', 1, 0), pack('graphic', 1, 10), pack('gsc', 0, 20), pack('old', 1, 5, 1)];

  it('既定のパック − 外したもの ＋ 足したものを、優先度の順に（取り下げたものは除く）', () => {
    expect(resolveRequires(packs, [], [])).toEqual(['basic', 'graphic']);
    expect(resolveRequires(packs, ['gsc'], ['graphic'])).toEqual(['basic', 'gsc']);
    expect(resolveRequires(packs, ['unknown', 'old'], [])).toEqual(['basic', 'graphic']);
  });

  it('カタログはシナリオと、使うパックだけを入れる', () => {
    const row: PlayableRow = {
      slug: 'lantern', title: 'ランタン号', author: null, license: 'CC0', description: null,
      number: 3, sha256: 'a'.repeat(64), root: 'lantern', eve: '01.eve', requires: '[]', excludes: '[]',
    };
    const c = catalog('Site', [row], packs);
    expect(c.entries[0]).toMatchObject({
      id: 'lantern', archive: '/files/scenarios/lantern/3.zip', version: '3-aaaaaaaaaaaa', root: 'lantern', eve: '01.eve',
      requires: ['basic', 'graphic'],
    });
    expect(c.entries.slice(1).map(e => [e.id, e.kind, e.archive])).toEqual([
      ['basic', 'asset', '/files/packs/basic/v1.zip'],
      ['graphic', 'asset', '/files/packs/graphic/v1.zip'],
    ]);
  });
});
