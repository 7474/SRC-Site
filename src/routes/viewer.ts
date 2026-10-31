// データビューア（/viewer/。7474/SRC の SRCDataViewer）が読む、公開している zip の一覧と中身の目次（docs/resources.md）
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { PLAYABLE_SELECT, resolveRequires, usablePack, type PackRow, type PlayableRow } from '../lib/catalog';
import { findArchive, listEntries, type ArchiveType } from '../lib/archives';
import { ZipError } from '../lib/zip';
import { parseJsonArray } from '../lib/util';
import { visibleSubmission } from './files';

export const viewer = new Hono<AppEnv>();

/**
 * データビューアのアーカイブの一覧の 1 項目（形は 7474/SRC の docs/gui/dataviewer.md）。
 * シナリオとパックは同じ ID を持てるので、一覧の ID は種類を前に付ける（scenarios/<slug>・packs/<id>）
 */
export const viewerId = (type: 'scenarios' | 'packs', id: string) => `${type}/${id}`;

export type ViewerArchive = {
  id: string;
  kind: 'scenario' | 'pack' | 'resource';
  title: string;
  author?: string;
  description?: string;
  license?: string;
  /** ポータルの頁 */
  page: string;
  /** zip の中のファイルの一覧（JSON） */
  files: string;
  /** zip の中のファイルの URL の前に付けるもの（base + zip の中の道） */
  base: string;
  root?: string;
  /** 重ねるアーカイブ（シナリオ） */
  requires?: string[];
};

viewer.get('/index.json', async c => {
  const [scenarios, packs] = await c.env.DB.batch([
    c.env.DB.prepare(`${PLAYABLE_SELECT} AND s.visibility = 'public' ORDER BY s.updated_at DESC`),
    c.env.DB.prepare('SELECT * FROM packs ORDER BY priority, id'),
  ]);
  const packRows = packs.results as PackRow[];
  const archives: ViewerArchive[] = [];
  for (const s of scenarios.results as PlayableRow[]) {
    archives.push({
      id: viewerId('scenarios', s.slug), kind: 'scenario', title: s.title, ...optional({ author: s.author, description: s.description?.slice(0, 200), license: s.license, root: s.root }),
      page: `/scenarios/${s.slug}`,
      files: `/api/viewer/archives/scenarios/${s.slug}/${s.number}.json`,
      base: `/files/scenarios/${s.slug}/${s.number}/`,
      requires: resolveRequires(packRows, parseJsonArray(s.requires), parseJsonArray(s.excludes)).map(id => viewerId('packs', id)),
    });
  }
  for (const p of packRows.filter(usablePack)) {
    archives.push({
      id: viewerId('packs', p.id), kind: 'pack', title: p.title, ...optional({ description: p.description, license: p.license, root: p.root }),
      page: `/packs/${p.id}`,
      files: `/api/viewer/archives/packs/${p.id}/${p.version}.json`,
      base: `/files/packs/${p.id}/${p.version}/`,
    });
  }
  c.header('Cache-Control', 'public, max-age=60');
  c.header('Cross-Origin-Resource-Policy', 'same-origin');
  return c.json({ format: 1, name: c.env.SITE_NAME, ...soundFont(packRows), archives });
});

/** MIDI を鳴らす SoundFont（.sf2）を探すアーカイブ。アーカイブ自身と重ねるものに .sf2 が無いときに使う */
function soundFont(packs: PackRow[]): { soundFont?: string } {
  const p = packs.find(x => x.id === SOUND_FONT_PACK && usablePack(x));
  return p ? { soundFont: viewerId('packs', p.id) } : {};
}
const SOUND_FONT_PACK = 'soundfont';

// パックへの投稿（承認前を含む）を、投稿した人とパックの管理者がデータビューアで開く（/viewer/archive?index=…&id=submission-<id>）。
// 重ねるのは投稿先のパック（組んだもの）。ファイルの一覧は検査で作った pack_files から返す（zip を読まない）
viewer.get('/submissions/:id/:file{index\\.json|files\\.json}', async c => {
  const s = await visibleSubmission(c, c.req.param('id'));
  if (!s) {
    return c.json({ error: 'not found' }, 404);
  }
  c.header('Cache-Control', 'private, max-age=0');
  if (c.req.param('file') === 'files.json') {
    const files = (await c.env.DB.prepare('SELECT path, size FROM pack_files WHERE submission_id = ? ORDER BY path').bind(s.id).all<{ path: string; size: number }>()).results;
    return c.json({ files });
  }
  const packs = (await c.env.DB.prepare('SELECT * FROM packs').all<PackRow>()).results;
  const pack = packs.find(p => p.id === s.pack_id);
  const archive: ViewerArchive = {
    id: `submission-${s.id}`, kind: 'resource', title: s.title, ...optional({ author: s.author, license: s.license }),
    page: `/my/submissions/${s.id}`,
    files: `/api/viewer/submissions/${s.id}/files.json`,
    base: `/files/pack-submissions/${s.id}/`,
    requires: pack && usablePack(pack) ? [viewerId('packs', pack.id)] : [],
  };
  return c.json({ format: 1, name: c.env.SITE_NAME, ...soundFont(packs), archives: [archive] });
});

// zip の中のファイルの一覧。版を含めて不変なので、Cache API に置く
viewer.get('/archives/:type{scenarios|packs}/:id/:file', async c => {
  const m = /^(.+)\.json$/.exec(c.req.param('file'));
  if (!m) {
    return c.notFound();
  }
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  const key = new Request(c.req.url, { method: 'GET' });
  const hit = await cache?.match(key);
  if (hit) {
    return hit;
  }
  const a = await findArchive(c.env.DB, c.req.param('type') as ArchiveType, c.req.param('id'), m[1]);
  if (!a) {
    return c.json({ error: 'not found' }, 404);
  }
  let entries;
  try {
    entries = await listEntries(c.env.FILES, a);
  } catch (e) {
    if (e instanceof ZipError) {
      return c.json({ error: e.message }, 404);
    }
    throw e;
  }
  const files = entries.filter(e => !e.directory && !e.encrypted).map(e => ({ path: e.name.replace(/\\/g, '/'), size: e.size }));
  const response = new Response(JSON.stringify({ files }), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
  });
  if (cache) {
    c.executionCtx.waitUntil(cache.put(key, response.clone()));
  }
  return response;
});

/** 値のある項目だけ */
function optional<T extends Record<string, string | null | undefined>>(values: T): Partial<Record<keyof T, string>> {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v)) as Partial<Record<keyof T, string>>;
}
