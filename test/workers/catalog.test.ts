// /api/catalog.json・/api/catalog/:file の経路の確かめ（既定のパックの扱い）
import { describe, expect, it } from 'vitest';
import { call, createPack, createScenario, createVersion, db, login } from './helpers';

type CatalogBody = { format: number; name: string; entries: { id: string; kind?: string; requires?: string[] }[] };

describe('/api/catalog.json の既定のパック', () => {
  it('公開シナリオが無くても、配れる既定のパックを入れる（取り下げた・組んでいない・既定でないパックは入れない）', async () => {
    const def = await createPack({ kind: 'site', isDefault: true });
    const withdrawnDef = await createPack({ kind: 'site', isDefault: true, withdrawn: true });
    const unbuiltDef = await createPack({ kind: 'site', isDefault: true, built: false });
    const optional = await createPack({ kind: 'site', isDefault: false });

    const res = await call('GET', '/api/catalog.json');
    expect(res.status).toBe(200);
    const body = await res.json<CatalogBody>();
    expect(body.entries.filter(e => e.kind !== 'asset')).toEqual([]);
    const assetIds = body.entries.filter(e => e.kind === 'asset').map(e => e.id);
    expect(assetIds).toContain(def);
    expect(assetIds).not.toContain(withdrawnDef);
    expect(assetIds).not.toContain(unbuiltDef);
    expect(assetIds).not.toContain(optional);
  });

  it('公開シナリオが既定のパックを外していても /api/catalog.json には入る。/api/catalog/:file には使うパックだけが入る', async () => {
    const user = await login();
    const def = await createPack({ kind: 'site', isDefault: true });
    const extra = await createPack({ owner: user });
    const s = await createScenario(user);
    const vid = await createVersion(s, { requires: [extra], excludes: [def] });
    await db().prepare('UPDATE scenarios SET latest_version = ? WHERE id = ?').bind(vid, s.id).run();

    const allRes = await call('GET', '/api/catalog.json');
    expect(allRes.status).toBe(200);
    const all = await allRes.json<CatalogBody>();
    expect(all.entries.find(e => e.id === s.slug)?.requires).not.toContain(def);
    const allAssets = all.entries.filter(e => e.kind === 'asset').map(e => e.id);
    expect(allAssets).toContain(def);
    expect(allAssets).toContain(extra);

    const singleRes = await call('GET', `/api/catalog/${s.slug}.json`);
    expect(singleRes.status).toBe(200);
    const single = await singleRes.json<CatalogBody>();
    const scenario = single.entries.find(e => e.id === s.slug);
    expect(scenario?.requires).not.toContain(def);
    expect(scenario?.requires).toContain(extra);
    const singleAssets = single.entries.filter(e => e.kind === 'asset').map(e => e.id);
    expect(singleAssets).not.toContain(def);
    expect(singleAssets).toContain(extra);
  });
});
