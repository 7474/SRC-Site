import { describe, expect, it } from 'vitest';
import { catalog, packCatalog, resolveRequires, type PackRow, type PlayableRow } from '../src/lib/catalog';
import { reportUrl } from '../src/lib/util';

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
      version_id: 42, number: 3, etag: 'abcdef0123456789-3', root: 'lantern', eve: '01.eve', requires: '[]', excludes: '[]',
    };
    const c = catalog('Site', [row], packs);
    expect(c.entries[0]).toMatchObject({
      id: 'lantern', archive: '/files/scenarios/lantern/3.zip', version: '3-abcdef012345', root: 'lantern', eve: '01.eve',
      requires: ['basic', 'graphic'],
    });
    expect(c.entries.slice(1).map(e => [e.id, e.kind, e.archive])).toEqual([
      ['basic', 'asset', '/files/packs/basic/v1.zip'],
      ['graphic', 'asset', '/files/packs/graphic/v1.zip'],
    ]);
  });
});

describe('packCatalog', () => {
  it('lists every available pack as a same-origin asset archive and omits withdrawn packs', () => {
    const basic = { ...pack('basic', 1, 0), source_name: 'SRC community', license: 'CC0-1.0', description: 'Basic data', root: 'Data' };
    const result = packCatalog('Site', [basic, pack('gsc', 0, 10), pack('removed', 0, 20, 1)]);
    expect(result).toEqual({
      format: 1,
      name: 'Site',
      entries: [
        {
          id: 'basic', kind: 'asset', title: 'basic', author: 'SRC community', license: 'CC0-1.0',
          description: 'Basic data', archive: '/files/packs/basic/v1.zip', version: 'v1', root: 'Data',
        },
        {
          id: 'gsc', kind: 'asset', title: 'gsc', author: 's', license: 'l',
          archive: '/files/packs/gsc/v1.zip', version: 'v1',
        },
      ],
    });
    expect(result.entries.every(entry => entry.archive.startsWith('/'))).toBe(true);
  });
});

describe('reportUrl', () => {
  it('フォームの URL が無ければ null', () => {
    expect(reportUrl(undefined)).toBeNull();
  });

  it('{url}・{title} を置き換える', () => {
    const template = 'https://docs.google.com/forms/d/e/x/viewform?usp=pp_url&entry.1={url}&entry.2={title}';
    expect(reportUrl(template, { url: 'https://src.koudenpa.net/scenarios/a', title: 'ランタン号 & 1' })).toBe(
      'https://docs.google.com/forms/d/e/x/viewform?usp=pp_url&entry.1=https%3A%2F%2Fsrc.koudenpa.net%2Fscenarios%2Fa&entry.2=%E3%83%A9%E3%83%B3%E3%82%BF%E3%83%B3%E5%8F%B7%20%26%201',
    );
    expect(reportUrl(template)).toBe('https://docs.google.com/forms/d/e/x/viewform?usp=pp_url&entry.1=&entry.2=');
  });
});
