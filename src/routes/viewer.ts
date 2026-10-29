// データビューア（/viewer/。7474/SRC の SRCTestBlazor）が読む、公開している zip の一覧と中身の目次（docs/resources.md）
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { loadPacks, memberId, packMembers, PLAYABLE_SELECT, resolveRequires, type PlayableRow } from '../lib/catalog';
import { findArchive, listEntries, type ArchiveType } from '../lib/archives';
import { ZipError } from '../lib/zip';
import { parseJsonArray } from '../lib/util';

export const viewer = new Hono<AppEnv>();

/** データビューアのアーカイブの一覧の 1 項目（形は 7474/SRC の docs/gui/dataviewer.md） */
export type ViewerArchive = {
  id: string;
  kind: 'scenario' | 'resource' | 'pack';
  title: string;
  author?: string;
  description?: string;
  license?: string;
  tags?: string[];
  /** ポータルの頁 */
  page: string;
  /** zip の中のファイルの一覧（JSON） */
  files?: string;
  /** zip の中のファイルの URL の前に付けるもの（base + zip の中の道） */
  base?: string;
  root?: string;
  /** 重ねるアーカイブ（シナリオ）。投稿素材のパックは中の素材に展開してある */
  requires?: string[];
  /** 投稿先のパック（素材） */
  pack?: string;
  /** パックの中の素材（投稿素材のパック。重ねる順） */
  members?: string[];
};

viewer.get('/index.json', async c => {
  const scenarios = (await c.env.DB.prepare(`${PLAYABLE_SELECT} AND s.visibility = 'public' ORDER BY s.updated_at DESC`).all<PlayableRow>()).results;
  const { packs, members } = await loadPacks(c.env.DB);
  const archives: ViewerArchive[] = [];
  for (const s of scenarios) {
    archives.push({
      id: s.slug, kind: 'scenario', title: s.title, ...optional({ author: s.author, description: s.description?.slice(0, 200), license: s.license, root: s.root }),
      page: `/scenarios/${s.slug}`,
      files: `/api/viewer/archives/scenarios/${s.slug}/${s.number}.json`,
      base: `/files/scenarios/${s.slug}/${s.number}/`,
      requires: resolveRequires(packs, parseJsonArray(s.requires), parseJsonArray(s.excludes), members),
    });
  }
  for (const m of members) {
    archives.push({
      id: memberId(m.slug), kind: 'resource', title: m.title, ...optional({ author: m.author, license: m.license, root: m.root }),
      page: `/resources/${m.slug}`,
      files: `/api/viewer/archives/resources/${m.slug}/${m.number}.json`,
      base: `/files/resources/${m.slug}/${m.number}/`,
      pack: m.pack_id,
    });
  }
  for (const p of packs.filter(x => !x.withdrawn).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))) {
    archives.push(p.kind === 'community'
      ? { id: p.id, kind: 'pack', title: p.title, license: p.license, page: `/packs/${p.id}`, members: packMembers(members, p.id).map(m => memberId(m.slug)) }
      : {
        id: p.id, kind: 'pack', title: p.title, license: p.license, ...optional({ root: p.root }), page: `/packs/${p.id}`,
        files: `/api/viewer/archives/packs/${p.id}/${p.version}.json`,
        base: `/files/packs/${p.id}/${p.version}/`,
      });
  }
  c.header('Cache-Control', 'public, max-age=60');
  c.header('Cross-Origin-Resource-Policy', 'same-origin');
  return c.json({ format: 1, name: c.env.SITE_NAME, archives });
});

// zip の中のファイルの一覧。版を含めて不変なので、Cache API に置く
viewer.get('/archives/:type{scenarios|resources|packs}/:id/:file', async c => {
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
