// SRC#Web のカタログ（https://github.com/7474/SRC/blob/master/docs/gui/web-hosting.md）を D1 から作る
import { parseJsonArray } from './util';

export type PackRow = {
  id: string; title: string; description: string | null; source_name: string; source_url: string | null; license: string;
  is_default: number; priority: number; root: string | null; version: string; r2_key: string; size: number; withdrawn: number;
};

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
  const available = new Map(packs.filter(p => !p.withdrawn).map(p => [p.id, p]));
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
  const entry: CatalogEntry = {
    id: p.id,
    kind: 'asset',
    title: p.title,
    author: p.source_name,
    license: p.license,
    archive: `/files/packs/${p.id}/${p.version}.zip`,
    version: p.version,
  };
  if (p.description) entry.description = p.description;
  if (p.root) entry.root = p.root;
  return entry;
}

export function catalog(name: string, scenarios: PlayableRow[], packs: PackRow[]) {
  const entries = scenarios.map(s => scenarioEntry(s, packs));
  const used = new Set(entries.flatMap(e => e.requires ?? []));
  return {
    format: 1,
    name,
    entries: [...entries, ...packs.filter(p => used.has(p.id) && !p.withdrawn).map(packEntry)],
  };
}

export function packCatalog(name: string, packs: PackRow[]) {
  return {
    format: 1,
    name,
    entries: packs.filter(p => !p.withdrawn).map(packEntry),
  };
}

export const PLAYABLE_SELECT = `
  SELECT s.slug, s.title, s.author, s.license, s.description,
         v.id AS version_id, v.number, v.etag, v.root, v.eve, v.requires, v.excludes
    FROM scenarios s JOIN versions v ON v.id = s.latest_version
   WHERE s.hidden = 0 AND v.state = 'published'`;
