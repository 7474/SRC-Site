// /api/catalog.json・/api/packs-catalog.json・/api/catalog/:file の経路の確かめ
import { describe, expect, it } from 'vitest';
import { call, createPack, createScenario, createVersion, db, login } from './helpers';

type CatalogBody = { format: number; name: string; entries: { id: string; kind?: string; requires?: string[] }[] };

describe('/api/packs-catalog.json と /api/catalog.json', () => {
  it('/api/packs-catalog.json は公開シナリオが無くても配れる既定パックだけを返し、/api/catalog.json は従来どおり空のまま', async () => {
    const def = await createPack({ kind: 'site', isDefault: true });
    const withdrawnDef = await createPack({ kind: 'site', isDefault: true, withdrawn: true });
    const unbuiltDef = await createPack({ kind: 'site', isDefault: true, built: false });
    const optional = await createPack({ kind: 'site', isDefault: false });

    const packsRes = await call('GET', '/api/packs-catalog.json');
    expect(packsRes.status).toBe(200);
    const packsBody = await packsRes.json<CatalogBody>();
    const assetIds = packsBody.entries.filter(e => e.kind === 'asset').map(e => e.id);
    expect(assetIds).toContain(def);
    expect(assetIds).not.toContain(withdrawnDef);
    expect(assetIds).not.toContain(unbuiltDef);
    expect(assetIds).not.toContain(optional);

    const catalogRes = await call('GET', '/api/catalog.json');
    expect(catalogRes.status).toBe(200);
    const catalogIds = (await catalogRes.json<CatalogBody>()).entries.map(e => e.id);
    expect(catalogIds).toEqual([]);
  });

  it('公開シナリオが既定パックを外していても /api/packs-catalog.json には入り、/api/catalog.json と /api/catalog/:file には使われるパックだけが入る', async () => {
    const user = await login();
    const def = await createPack({ kind: 'site', isDefault: true });
    const extra = await createPack({ owner: user });
    const s = await createScenario(user);
    const vid = await createVersion(s, { requires: [extra], excludes: [def] });
    await db().prepare('UPDATE scenarios SET latest_version = ? WHERE id = ?').bind(vid, s.id).run();

    const packsRes = await call('GET', '/api/packs-catalog.json');
    expect(packsRes.status).toBe(200);
    const packIds = (await packsRes.json<CatalogBody>()).entries.filter(e => e.kind === 'asset').map(e => e.id);
    expect(packIds).toContain(def);
    expect(packIds).not.toContain(extra);

    const allRes = await call('GET', '/api/catalog.json');
    expect(allRes.status).toBe(200);
    const allIds = (await allRes.json<CatalogBody>()).entries.filter(e => e.kind === 'asset').map(e => e.id);
    expect(allIds).not.toContain(def);
    expect(allIds).toContain(extra);

    const singleRes = await call('GET', `/api/catalog/${s.slug}.json`);
    expect(singleRes.status).toBe(200);
    const singleBody = await singleRes.json<CatalogBody>();
    const singleScenario = singleBody.entries.find(e => e.id === s.slug);
    expect(singleScenario?.requires).not.toContain(def);
    expect(singleScenario?.requires).toContain(extra);
    const singleAssets = singleBody.entries.filter(e => e.kind === 'asset').map(e => e.id);
    expect(singleAssets).not.toContain(def);
    expect(singleAssets).toContain(extra);
  });
});
