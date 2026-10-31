// SRC#Web のカタログ（https://github.com/7474/SRC/blob/master/docs/gui/web-hosting.md）を D1 から作る
import { parseJsonArray } from './util';

export type PackRow = {
  id: string; title: string; description: string | null; source_name: string; source_url: string | null; license: string;
  is_default: number; priority: number; root: string | null; version: string; r2_key: string; size: number; withdrawn: number;
  /** 'site'（運営が配布物から作る）| 'community'（利用者が作り、投稿を承認して組む）。古い行・テストでは省く */
  kind?: string;
};

/** 配れるパック（取り下げておらず、zip がある。利用者が作ったパックは一度も組んでいなければ zip が無い） */
export function usablePack(p: PackRow): boolean {
  return !p.withdrawn && p.r2_key !== '';
}

/** 配れるパック（usablePack）を D1 から選ぶ条件 */
export const USABLE_PACK_SQL = "withdrawn = 0 AND r2_key != ''";

export type PlayableRow = {
  slug: string; title: string; author: string | null; license: string | null; description: string | null;
  version_id: number; number: number; etag: string; root: string | null; eve: string | null; requires: string; excludes: string;
};

export type CatalogEntry = {
  id: string; title: string; kind?: 'asset'; author?: string; license?: string; description?: string;
  archive: string; version: string; root?: string; eve?: string; requires?: string[];
};

/** シナリオが重ねるパック: サイトの既定 − 外したもの ＋ 足したもの を、priority の順に（後ほど優先） */
export function resolveRequires(packs: PackRow[], requires: string[], excludes: string[]): string[] {
  const available = new Map(packs.filter(usablePack).map(p => [p.id, p]));
  const ids = new Set<string>();
  for (const p of available.values()) {
    if (p.is_default && !excludes.includes(p.id)) {
      ids.add(p.id);
    }
  }
  for (const id of requires) {
    if (available.has(id)) {
      ids.add(id);
    }
  }
  return [...ids].sort((a, b) => (available.get(a)!.priority - available.get(b)!.priority) || a.localeCompare(b));
}

/** 選んだパックから、版の requires（既定でないもので選んだもの）と excludes（既定で外したもの）を作る */
export function packSettings(packs: { id: string; is_default: number }[], chosen: Iterable<string>): { requires: string[]; excludes: string[] } {
  const set = new Set(chosen);
  return {
    requires: packs.filter(p => !p.is_default && set.has(p.id)).map(p => p.id),
    excludes: packs.filter(p => p.is_default && !set.has(p.id)).map(p => p.id),
  };
}

/** 版で使う共有パックを選んだものから作る。選べるのは配れるパック（編集の頁・上げる画面に出すもの）だけで、ほかは無視する */
export async function choosePacks(db: D1Database, chosen: Iterable<string>): Promise<{ requires: string[]; excludes: string[] }> {
  const packs = (await db.prepare(`SELECT id, is_default FROM packs WHERE ${USABLE_PACK_SQL}`).all<{ id: string; is_default: number }>()).results;
  return packSettings(packs, chosen);
}

export function scenarioEntry(row: PlayableRow, packs: PackRow[]): CatalogEntry {
  const entry: CatalogEntry = {
    id: row.slug,
    title: row.title,
    archive: `/files/scenarios/${row.slug}/${row.number}.zip`,
    // SRC#Web は version が変わったときだけ zip を取り直す。R2 の ETag（古い版は sha256）で中身が変われば変わる。無ければ版の ID
    version: `${row.number}-${(row.etag || String(row.version_id)).replace(/[^0-9a-zA-Z]/g, '').slice(0, 12)}`,
    requires: resolveRequires(packs, parseJsonArray(row.requires), parseJsonArray(row.excludes)),
  };
  if (row.author) entry.author = row.author;
  if (row.license) entry.license = row.license;
  if (row.description) entry.description = row.description.slice(0, 200);
  if (row.root) entry.root = row.root;
  if (row.eve) entry.eve = row.eve;
  return entry;
}

export function packEntry(p: PackRow): CatalogEntry {
  const entry: CatalogEntry = { id: p.id, kind: 'asset', title: p.title, archive: `/files/packs/${p.id}/${p.version}.zip`, version: p.version };
  if (p.root) entry.root = p.root;
  return entry;
}

export function catalog(name: string, scenarios: PlayableRow[], packs: PackRow[]) {
  const entries = scenarios.map(s => scenarioEntry(s, packs));
  const used = new Set(entries.flatMap(e => e.requires ?? []));
  return {
    format: 1,
    name,
    entries: [...entries, ...packs.filter(p => used.has(p.id) && usablePack(p)).map(packEntry)],
  };
}

/** zip の URL（lint・チェッカーが汎用データを読むときに使う） */
export function archiveUrls(packs: PackRow[], ids: string[]): string[] {
  return ids.map(id => packs.find(p => p.id === id)).filter((p): p is PackRow => Boolean(p)).map(p => `/files/packs/${p.id}/${p.version}.zip`);
}

export const PLAYABLE_SELECT = `
  SELECT s.slug, s.title, s.author, s.license, s.description,
         v.id AS version_id, v.number, v.etag, v.root, v.eve, v.requires, v.excludes
    FROM scenarios s JOIN versions v ON v.id = s.latest_version
   WHERE s.hidden = 0 AND v.state = 'published'`;
