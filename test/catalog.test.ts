import { describe, expect, it } from 'vitest';
import { archiveUrls, catalog, resolveRequires, type PackRow, type PlayableRow } from '../src/lib/catalog';
import { entryContentType } from '../src/lib/archives';
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

describe('利用者が作ったパック', () => {
  const community = (id: string, built: boolean): PackRow => ({
    ...pack(id, 0, 200), kind: 'community', version: built ? '7-abcd' : '', r2_key: built ? `packs/${id}/build-7.zip` : '', size: built ? 10 : 0,
  });
  const packs = [pack('basic', 1, 0), community('faces', true), community('empty', false)];

  it('まだ zip に反映していないパックは重ねない。反映したものは 1 つの zip として重ねる', () => {
    expect(resolveRequires(packs, ['faces', 'empty'], [])).toEqual(['basic', 'faces']);
    const row: PlayableRow = {
      slug: 'lantern', title: 'ランタン号', author: null, license: null, description: null,
      version_id: 1, number: 1, etag: 'e', root: null, eve: null, requires: '["faces","empty"]', excludes: '[]',
    };
    expect(catalog('Site', [row], packs).entries.slice(1).map(e => e.archive)).toEqual(['/files/packs/basic/v1.zip', '/files/packs/faces/7-abcd.zip']);
    expect(archiveUrls(packs, ['basic', 'faces'])).toEqual(['/files/packs/basic/v1.zip', '/files/packs/faces/7-abcd.zip']);
  });
});

describe('entryContentType', () => {
  it('画像・音だけ種類を付け、ほかは中身を解釈させない', () => {
    expect(['a.BMP', 'b.png', 'c.wav', 'd.MP3', 'e.mid', 'f.svg', 'g.html', 'h.txt'].map(entryContentType)).toEqual([
      'image/bmp', 'image/png', 'audio/wav', 'audio/mpeg', 'audio/midi', 'application/octet-stream', 'application/octet-stream', 'application/octet-stream',
    ]);
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
