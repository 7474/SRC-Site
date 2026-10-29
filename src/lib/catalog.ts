// SRC#Web のカタログ（https://github.com/7474/SRC/blob/master/docs/gui/web-hosting.md）を D1 から作る
import { parseJsonArray } from './util';

export type PackRow = {
  id: string; title: string; description: string | null; source_name: string; source_url: string | null; license: string;
  is_default: number; priority: number; root: string | null; version: string; r2_key: string; size: number; withdrawn: number;
  /** 'site'（運営が配布物から作る zip）| 'community'（投稿した素材を集めたもの。zip を持たない）。古い行のテストでは省く */
  kind?: string;
};

export type PlayableRow = {
  slug: string; title: string; author: string | null; license: string | null; description: string | null;
  version_id: number; number: number; etag: string; root: string | null; eve: string | null; requires: string; excludes: string;
};

/** 投稿素材のパックに入っている素材（公開している最新の版） */
export type MemberRow = {
  pack_id: string; slug: string; title: string; author: string | null; license: string | null;
  version_id: number; number: number; etag: string; root: string | null; size: number;
};

export type CatalogEntry = {
  id: string; title: string; kind?: 'asset'; author?: string; license?: string; description?: string;
  archive: string; version: string; root?: string; eve?: string; requires?: string[];
};

/** 素材のカタログの ID。パックの ID と重ならないように、投稿の ID（slug）の前に付ける */
export const memberId = (slug: string) => `resource.${slug}`;

/** 版の zip の識別（SRC#Web は version が変わったときだけ zip を取り直す）。R2 の ETag（古い版は sha256）で中身が変われば変わる。無ければ版の ID */
function versionTag(row: { number: number; etag: string; version_id: number }) {
  return `${row.number}-${(row.etag || String(row.version_id)).replace(/[^0-9a-zA-Z]/g, '').slice(0, 12)}`;
}

/** シナリオが重ねるパック: サイトの既定 − 外したもの ＋ 足したもの を、priority の順に（後ほど優先） */
export function selectPacks(packs: PackRow[], requires: string[], excludes: string[]): string[] {
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

/**
 * カタログの requires: 重ねるパック（selectPacks）の、投稿素材のパックを中の素材（memberId）に展開したもの。
 * 素材は新しく投稿したものから並べ、先に投稿したものを後ろ（優先）にする
 */
export function resolveRequires(packs: PackRow[], requires: string[], excludes: string[], members: MemberRow[] = []): string[] {
  const kinds = new Map(packs.map(p => [p.id, p.kind]));
  return selectPacks(packs, requires, excludes)
    .flatMap(id => (kinds.get(id) === 'community' ? packMembers(members, id).map(m => memberId(m.slug)) : [id]));
}

/** パックの素材を、重ねる順（新しい投稿が先、古い投稿が後＝優先）に。members は MEMBER_SELECT の順（古い順） */
export function packMembers(members: MemberRow[], packId: string): MemberRow[] {
  return members.filter(m => m.pack_id === packId).reverse();
}

export function scenarioEntry(row: PlayableRow, packs: PackRow[], members: MemberRow[] = []): CatalogEntry {
  const entry: CatalogEntry = {
    id: row.slug,
    title: row.title,
    archive: `/files/scenarios/${row.slug}/${row.number}.zip`,
    version: versionTag(row),
    requires: resolveRequires(packs, parseJsonArray(row.requires), parseJsonArray(row.excludes), members),
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

export function memberEntry(m: MemberRow): CatalogEntry {
  const entry: CatalogEntry = {
    id: memberId(m.slug), kind: 'asset', title: m.title, archive: `/files/resources/${m.slug}/${m.number}.zip`, version: versionTag(m),
  };
  if (m.author) entry.author = m.author;
  if (m.license) entry.license = m.license;
  if (m.root) entry.root = m.root;
  return entry;
}

export function catalog(name: string, scenarios: PlayableRow[], packs: PackRow[], members: MemberRow[] = []) {
  const entries = scenarios.map(s => scenarioEntry(s, packs, members));
  const used = new Set(entries.flatMap(e => e.requires ?? []));
  return {
    format: 1,
    name,
    entries: [
      ...entries,
      ...packs.filter(p => used.has(p.id) && !p.withdrawn).map(packEntry),
      ...members.filter(m => used.has(memberId(m.slug))).map(memberEntry),
    ],
  };
}

/** zip の URL（lint・チェッカーが汎用データを読むときに使う）。投稿素材のパックは中の素材の zip */
export function archiveUrls(packs: PackRow[], ids: string[], members: MemberRow[]): string[] {
  return ids.flatMap(id => {
    const p = packs.find(x => x.id === id);
    if (p) {
      return p.kind === 'community' ? [] : [`/files/packs/${p.id}/${p.version}.zip`];
    }
    const m = members.find(x => memberId(x.slug) === id);
    return m ? [`/files/resources/${m.slug}/${m.number}.zip`] : [];
  });
}

export const PLAYABLE_SELECT = `
  SELECT s.slug, s.title, s.author, s.license, s.description,
         v.id AS version_id, v.number, v.etag, v.root, v.eve, v.requires, v.excludes
    FROM scenarios s JOIN versions v ON v.id = s.latest_version
   WHERE s.kind = 'scenario' AND s.hidden = 0 AND v.state = 'published'`;

/** 投稿素材のパックに入れる素材（公開・限定公開で、運営が止めていないもの）。古い投稿から順に */
export const MEMBER_SELECT = `
  SELECT s.pack_id, s.slug, s.title, s.author, s.license, v.id AS version_id, v.number, v.etag, v.root, v.size
    FROM scenarios s JOIN versions v ON v.id = s.latest_version
   WHERE s.kind = 'resource' AND s.pack_id IS NOT NULL AND s.hidden = 0 AND s.visibility != 'private' AND v.state = 'published'
   ORDER BY s.created_at, s.id`;

export async function loadPacks(db: D1Database): Promise<{ packs: PackRow[]; members: MemberRow[] }> {
  const [packs, members] = await db.batch([db.prepare('SELECT * FROM packs'), db.prepare(MEMBER_SELECT)]);
  return { packs: packs.results as PackRow[], members: members.results as MemberRow[] };
}
