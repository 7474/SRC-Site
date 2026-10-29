// ローカルの wrangler dev（DEV_LOGIN=1）に対して、投稿から配信・運営までを一通り確かめる。
// 使い方: node scripts/smoke.mjs <シナリオのフォルダ> [http://127.0.0.1:8787]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import assert from 'node:assert/strict';

const folder = process.argv[2];
const base = process.argv[3] ?? 'http://127.0.0.1:8787';
const slug = 'smoke-' + Date.now().toString(36);

// ブラウザの代わり（Cookie を持ち、同じオリジンの Origin を付ける）
class Agent {
  cookies = new Map();
  async req(path, init = {}) {
    const headers = new Headers(init.headers);
    if (this.cookies.size) {
      headers.set('Cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    }
    if (init.method && init.method !== 'GET' && !headers.has('Origin')) {
      headers.set('Origin', base);
    }
    const res = await fetch(base + path, { ...init, headers, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [k, v] = pair.split('=');
      if (v === '' || /Max-Age=0/i.test(c)) this.cookies.delete(k); else this.cookies.set(k, v);
    }
    return res;
  }
  form(path, data) {
    return this.req(path, { method: 'POST', body: new URLSearchParams(data) });
  }
}

function zipFolder(dir, extra, pad = 0) {
  const out = join(mkdtempSync(join(tmpdir(), 'smoke-')), 'scenario.zip');
  execFileSync('python3', ['-I', '-c', `
import os, sys, zipfile
src, out, extra = sys.argv[1], sys.argv[2], sys.argv[3]
root = os.path.basename(src.rstrip('/'))
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for d, _, files in os.walk(src):
        for f in files:
            p = os.path.join(d, f)
            z.write(p, os.path.join(root, os.path.relpath(p, src)))
    if extra:
        z.writestr(os.path.join(root, extra), b'MZ')
    if int(sys.argv[4]):
        z.writestr(os.path.join(root, 'padding.bin'), os.urandom(int(sys.argv[4])), zipfile.ZIP_STORED)
`, dir, out, extra ?? '', String(pad)]);
  return readFileSync(out);
}

async function upload(agent, data, target = slug) {
  let res = await agent.req(`/api/scenarios/${target}/versions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ size: data.length }) });
  assert.equal(res.status, 200, await res.clone().text());
  const created = await res.json();
  assert.equal(created.parts, Math.ceil(data.length / created.partSize));
  const parts = [];
  for (let n = 1; n <= created.parts; n++) {
    const body = data.subarray((n - 1) * created.partSize, n * created.partSize);
    res = await agent.req(`/api/versions/${created.versionId}/parts/${n}`);
    const target = await res.json();
    assert.equal(target.direct, false, 'ローカルでは Worker を通す');
    assert.equal(target.length, body.length);
    const url = target.url;
    if (n === 1) {
      res = await agent.req(url, { method: 'PUT', body: body.subarray(1) });
      assert.equal(res.status, 400, '大きさが違うパートは断る');
      // 同じパートを上げ直してもよい（通信が切れたときの再試行）
      res = await agent.req(url, { method: 'PUT', body });
      assert.equal(res.status, 200, 'part');
    }
    res = await agent.req(url, { method: 'PUT', body });
    assert.equal(res.status, 200, 'part');
    parts.push(await res.json());
  }
  res = await agent.req(`/api/versions/${created.versionId}/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parts }) });
  assert.equal(res.status, 200, 'complete ' + await res.clone().text());
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    const v = await (await agent.req(`/api/versions/${created.versionId}`)).json();
    if (v.state !== 'inspecting') return v;
  }
  throw new Error('検査が終わりません');
}

const step = (name) => console.log('✓', name);
const alice = new Agent();
const visitor = new Agent();
const admin = new Agent();

let res = await alice.req('/auth/dev?as=alice-' + slug + '&next=/my');
assert.equal(res.status, 302);
res = await alice.req('/my/scenarios/new');
assert.equal(res.headers.get('Location'), '/my', '規約に同意するまで投稿できない');
res = await alice.form('/my', { handle: 'alice-' + slug.slice(-6), terms: '1' });
assert.equal(res.status, 302);
step('ログインと規約への同意');

res = await alice.form('/my/scenarios/new', { slug, title: 'スモーク ' + basename(folder), author: '作者', description: '説明', license: 'CC0', tags: 'テスト 短編', visibility: 'public' });
assert.equal(res.headers.get('Location'), `/my/scenarios/${slug}`);
step('シナリオの登録');

const zip = zipFolder(folder);
let v = await upload(alice, zip);
assert.equal(v.state, 'published', v.note);
step(`第 ${v.number} 版の投稿と検査（${zip.length} バイト）`);

const bad = await upload(alice, zipFolder(folder, 'setup.exe'));
assert.equal(bad.state, 'rejected');
assert.match(bad.note, /実行ファイル/);
step('実行ファイルを含む版は弾く: ' + bad.note);

res = await visitor.req('/api/catalog.json');
let catalog = await res.json();
const entry = catalog.entries.find(e => e.id === slug);
assert.ok(entry, 'カタログに出る');
assert.equal(entry.archive, `/files/scenarios/${slug}/1.zip`);
assert.equal(entry.root, basename(folder));
assert.ok(entry.eve.endsWith('.eve'));
step(`カタログ（root=${entry.root}, eve=${entry.eve}）`);

res = await visitor.req(`/api/catalog/${slug}.json`);
assert.equal((await res.json()).entries[0].id, slug);
res = await visitor.req(entry.archive);
assert.equal(res.status, 200);
assert.equal(Buffer.from(await res.arrayBuffer()).length, zip.length);
res = await visitor.req(entry.archive, { headers: { Range: 'bytes=0-3' } });
assert.equal(res.status, 206);
assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [0x50, 0x4b, 0x03, 0x04]);
res = await visitor.req(`/scenarios/${slug}/download`);
assert.match(res.headers.get('Content-Disposition'), /attachment/);
await res.arrayBuffer();
res = await visitor.req(`/files/scenarios/${slug}/2.zip`);
assert.equal(res.status, 404, '弾いた版は配らない');
step('zip の配信（全体・Range・ダウンロード）');

res = await visitor.req('/');
assert.match(await res.text(), new RegExp(slug));
res = await visitor.req('/?q=短編');
assert.match(await res.text(), new RegExp(slug));
step('一覧と検索');

res = await alice.form(`/my/scenarios/${slug}`, { title: 'スモーク 改題', visibility: 'public', tags: '', author: '', description: '', license: '' });
assert.equal(res.status, 302);
res = await visitor.req(`/scenarios/${slug}`);
const page = await res.text();
assert.match(page, /スモーク 改題/);
assert.match(page, /SRC#Web で遊ぶ/);
catalog = await (await visitor.req('/api/catalog.json')).json();
assert.equal(catalog.entries.find(e => e.id === slug).rating, undefined);
step('編集とシナリオの頁（年齢の区分は無い）');

res = await fetch(base + `/my/scenarios/${slug}/delete`, { method: 'POST', headers: { Origin: 'https://evil.example' } });
assert.equal(res.status, 403);
step('別のサイトからの POST は断る');

await admin.req('/auth/dev?as=admin-' + slug + '&admin=1&next=/admin');
res = await admin.req(`/scenarios/${slug}`);
assert.match(await res.text(), /運営: 公開を止める/);
assert.doesNotMatch(await (await visitor.req(`/scenarios/${slug}`)).text(), /運営: 公開を止める/);
res = await admin.form(`/admin/scenarios/${slug}/hide`, { reason: '確認中' });
assert.equal(res.status, 302);
assert.equal((await visitor.req(entry.archive)).status, 404, '止めたら配らない');
assert.equal((await visitor.req(`/scenarios/${slug}`)).status, 404);
res = await alice.req(`/scenarios/${slug}`);
assert.match(await res.text(), /運営により公開を止めています/);
assert.match(await (await admin.req('/admin')).text(), new RegExp(slug));
res = await admin.form(`/admin/scenarios/${slug}/unhide`, {});
assert.equal((await visitor.req(entry.archive)).status, 200);
step('運営が止める → 再開');

res = await visitor.req('/admin');
assert.equal(res.status, 404, '運営の頁は運営だけ');

// 素材を投稿素材のパックに投稿し、シナリオで使う（docs/resources.md）
const resSlug = slug + '-res';
res = await alice.form('/my/resources/new', { slug: resSlug, title: 'スモークの素材', pack: 'user-free', visibility: 'public' });
assert.equal(res.status, 400, '管理ポリシーへの同意が要る');
res = await alice.form('/my/resources/new', { slug: resSlug, title: 'スモークの素材', pack: 'user-free', agree: '1', visibility: 'public' });
assert.equal(res.headers.get('Location'), `/my/scenarios/${resSlug}`);
const bmp = Buffer.from('424d3a0000000000000036000000280000000100000001000000010018000000000004000000130b0000130b00000000000000000000ff000000', 'hex');
const resourceZip = (() => {
  const out = join(mkdtempSync(join(tmpdir(), 'smoke-')), 'resource.zip');
  execFileSync('python3', ['-I', '-c', `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('Bitmap/Pilot/スモーク.bmp', bytes.fromhex(sys.argv[2]))
    z.writestr('Sound/smoke.wav', b'RIFF' + bytes(100))
`, out, bmp.toString('hex')]);
  return readFileSync(out);
})();
v = await upload(alice, resourceZip, resSlug);
assert.equal(v.state, 'published', v.note);
res = await visitor.req(`/scenarios/${resSlug}`);
assert.equal(res.headers.get('Location'), `/resources/${resSlug}`, '素材の頁へ移す');
res = await visitor.req(`/resources/${resSlug}`);
assert.match(await res.text(), /投稿素材（自由）/);
assert.match(await (await visitor.req('/packs/user-free')).text(), new RegExp(resSlug));
step('素材の投稿（.eve なし）と素材・パックの頁');

const edit = await (await alice.req(`/my/scenarios/${slug}`)).text();
const versionId = /\/my\/versions\/(\d+)\/packs/.exec(edit)[1];
res = await alice.req(`/my/versions/${versionId}/packs`, { method: 'POST', body: new URLSearchParams([['pack', 'user-free']]) });
assert.equal(res.status, 302);
catalog = await (await visitor.req(`/api/catalog/${slug}.json`)).json();
assert.deepEqual(catalog.entries[0].requires, [`resource.${resSlug}`]);
const asset = catalog.entries.find(e => e.id === `resource.${resSlug}`);
assert.equal(asset.kind, 'asset');
assert.equal((await visitor.req(asset.archive)).status, 200);
step('シナリオが投稿素材のパックを使う（カタログの requires に素材が入る）');

const index = await (await visitor.req('/api/viewer/index.json')).json();
const archive = index.archives.find(a => a.id === `resource.${resSlug}`);
assert.equal(archive.pack, 'user-free');
assert.ok(index.archives.find(a => a.id === 'user-free').members.includes(`resource.${resSlug}`));
assert.deepEqual(index.archives.find(a => a.id === slug).requires, [`resource.${resSlug}`]);
const list = await (await visitor.req(archive.files)).json();
assert.deepEqual(list.files.map(f => f.path).sort(), ['Bitmap/Pilot/スモーク.bmp', 'Sound/smoke.wav']);
res = await visitor.req(archive.base + encodeURI('bitmap/pilot/スモーク.bmp'));
assert.equal(res.status, 200);
assert.equal(res.headers.get('Content-Type'), 'image/bmp');
assert.deepEqual(Buffer.from(await res.arrayBuffer()), bmp);
res = await visitor.req(archive.base + 'Sound/smoke.wav', { headers: { Range: 'bytes=0-3' } });
assert.equal(res.status, 206);
assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'RIFF');
assert.equal((await visitor.req(archive.base + 'Sound/none.wav')).status, 404);
assert.equal((await visitor.req(archive.base + '../x')).status, 404);
step('データビューアの一覧・目次・zip の中のファイル（画像・Range）');

res = await alice.form(`/my/scenarios/${resSlug}/delete`, {});
assert.equal(res.status, 302);
catalog = await (await visitor.req(`/api/catalog/${slug}.json`)).json();
assert.deepEqual(catalog.entries[0].requires, [], '消した素材は重ねない');
step('素材の削除');

// 複数のパートに分かれる大きさ（Worker を通したマルチパートアップロード）
const large = zipFolder(folder, undefined, 70 * 1024 * 1024);
v = await upload(alice, large);
assert.equal(v.state, 'published', v.note);
step(`第 ${v.number} 版の投稿と検査（${large.length} バイト、パートに分けて）`);

res = await alice.form(`/my/scenarios/${slug}/delete`, {});
assert.equal(res.status, 302);
assert.equal((await visitor.req(entry.archive)).status, 404);
step('シナリオの削除');
console.log('すべて成功');
