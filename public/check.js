// データ・シナリオのチェッカー（/check）。選ぶかドロップした zip・フォルダ・ファイルを、ブラウザの中だけで確かめる。
// 1. zip の目次を調べ、中身の種類（シナリオ・データだけ・どちらでもない）を決める（precheck.js の survey）
// 2. 種類に合わせて srcsharp lint をかける（lint-ui.js）。結果は投稿の画面と同じ表で出す
// zip でないもの（フォルダ・ファイル）は、.eve と .txt の中身と、ほかのファイルの名前だけを zip にまとめてから確かめる（素材は名前で探すため）。
// フォルダは、フォルダの名前を最上位に置いてまとめるので、そのフォルダを zip にしたもの（解凍したもの）と同じに確かめる。
// 依存データ（手元の SRC 本体・GSC データパックなど）は、要るもの（System の .txt・Lib の .eve と、ほかの名前）だけにしてブラウザの IndexedDB に覚え、汎用データとして重ねる
(() => {
  const form = document.getElementById('check');
  if (!form) {
    return;
  }
  const zone = form.querySelector('.dropzone:not(.deps-zone)');
  const depsZone = form.querySelector('.deps-zone');
  const depsStatus = form.querySelector('.deps-status');
  const depList = form.querySelector('.dep-list');
  const status = form.querySelector('.status');
  const progress = form.querySelector('progress');
  const cancel = form.querySelector('.lint-cancel');
  const recheck = form.querySelector('.recheck');
  const summary = form.querySelector('.check-summary');
  const lintBox = form.querySelector('.lint');
  const packs = JSON.parse(form.dataset.packs || '[]');
  const show = (text, error) => {
    status.textContent = text;
    status.classList.toggle('error', Boolean(error));
  };
  let current = null;
  let running = false;
  // .git などの隠しフォルダは見ない（SRC は使わず、ファイルが多いことがある）
  const HIDDEN = /(^|\/)\.[^/]+\//;
  const precheck = () => import('/static/precheck.js');

  // ---- 確かめ方（パック・素材）は次に開いたときも使う（保存できなくても既定のまま使える） ----
  const OPTIONS_KEY = 'check.options';
  try {
    const saved = JSON.parse(localStorage.getItem(OPTIONS_KEY) || 'null');
    if (saved) {
      for (const input of form.querySelectorAll('input[name=pack]')) {
        if (saved.packs && input.value in saved.packs) {
          input.checked = saved.packs[input.value];
        }
      }
      if (typeof saved.assets === 'boolean') {
        form.assets.checked = saved.assets;
      }
    }
  } catch {}
  form.querySelector('.check-options').addEventListener('change', () => {
    try {
      const chosen = Object.fromEntries([...form.querySelectorAll('input[name=pack]')].map(i => [i.value, i.checked]));
      localStorage.setItem(OPTIONS_KEY, JSON.stringify({ packs: chosen, assets: form.assets.checked }));
    } catch {}
  });

  // ---- 確かめるもの ----
  form.file.addEventListener('change', () => fromFiles([...form.file.files].map(f => ({ path: f.name, file: f }))));
  form.folder.addEventListener('change', () => fromFiles(...fromPicker(form.folder.files)));
  recheck.addEventListener('click', () => current && check(current));
  onDrop(zone, ({ files, skipped, folder }) => fromFiles(files, skipped, folder));

  // ---- 依存データ ----
  form.depFolder.addEventListener('change', () => addDependency(...fromPicker(form.depFolder.files)));
  form.depFile.addEventListener('change', async () => {
    for (const f of [...form.depFile.files]) {
      await addDependency([{ path: f.name, file: f }], [], null);
    }
  });
  onDrop(depsZone, async ({ files, skipped, folder }) => {
    const zips = files.filter(f => /\.zip$/i.test(f.path));
    if (zips.length === files.length) {
      for (const z of zips) {
        await addDependency([z], [], null);
      }
    } else {
      await addDependency(files.filter(f => !/\.zip$/i.test(f.path)), skipped, folder);
    }
  });
  renderDependencies();

  // 「フォルダを選ぶ」で選んだファイル。フォルダを 1 つ選んだなら、その名前も返す
  function fromPicker(fileList) {
    const files = [...fileList].map(f => ({ path: f.webkitRelativePath || f.name, file: f })).filter(f => !HIDDEN.test(f.path));
    const tops = new Set(files.map(f => f.path.split('/')[0]));
    const folder = tops.size === 1 && files.some(f => f.path.includes('/')) ? [...tops][0] : null;
    return [files, [], folder];
  }

  // ドロップを受け付ける（フォルダは中をたどる）。handler には { files, skipped, folder } を渡す
  function onDrop(target, handler) {
    for (const type of ['dragenter', 'dragover']) {
      target.addEventListener(type, e => {
        e.preventDefault();
        target.classList.add('over');
      });
    }
    target.addEventListener('dragleave', e => {
      if (!target.contains(e.relatedTarget)) {
        target.classList.remove('over');
      }
    });
    target.addEventListener('drop', async e => {
      e.preventDefault();
      target.classList.remove('over');
      const entries = [...e.dataTransfer.items].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
      if (!entries.length) {
        handler({ files: [...e.dataTransfer.files].map(f => ({ path: f.name, file: f })), skipped: [], folder: null });
        return;
      }
      const files = [];
      const skipped = [];
      for (const entry of entries) {
        await walk(entry, '', files, skipped);
      }
      // フォルダを 1 つだけドロップしたときは、そのフォルダを zip にしたものと同じに扱う
      handler({ files, skipped, folder: entries.length === 1 && entries[0].isDirectory ? entries[0].name : null });
    });
  }

  // ドロップしたフォルダをたどる。読めないもの（名前の文字など）は飛ばして skipped に入れる
  async function walk(entry, prefix, out, skipped) {
    const path = prefix + entry.name;
    if (entry.isFile) {
      try {
        out.push({ path, file: await new Promise((resolve, reject) => entry.file(resolve, reject)) });
      } catch {
        skipped.push(path);
      }
      return;
    }
    if (prefix && entry.name.startsWith('.')) {
      return;
    }
    try {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) {
          break;
        }
        for (const child of batch) {
          await walk(child, path + '/', out, skipped);
        }
      }
    } catch {
      skipped.push(path + '/');
    }
  }

  // フォルダ・ファイルを zip にまとめる。keep(path) が真のものだけ中身を入れ、ほかは名前だけ
  async function pack(files, keep) {
    const { buildZip } = await precheck();
    const entries = [];
    for (const { path, file } of files) {
      const data = keep(path) ? new Uint8Array(await file.arrayBuffer()) : new Uint8Array(0);
      entries.push({ name: path.replace(/\\/g, '/'), data });
    }
    return { blob: buildZip(entries), count: entries.length };
  }

  /** files: [{ path, file }]、skipped: 読めなかったもの、folder: フォルダを 1 つ選んだならその名前 */
  async function fromFiles(files, skipped = [], folder = null) {
    if (running) {
      return;
    }
    if (!files.length) {
      show(skipped.length ? `ファイルを読めませんでした（${skipped.length} 個）。` : 'ファイルがありません。', true);
      return;
    }
    // zip 1 つならそのまま。ほかはまとめる
    if (files.length === 1 && /\.zip$/i.test(files[0].path)) {
      current = { blob: files[0].file, name: files[0].path, packed: false, skipped };
    } else {
      show('ファイルをまとめています…');
      // zip は 1 つずつ確かめる
      const loose = files.filter(f => !/\.zip$/i.test(f.path));
      skipped = [...skipped, ...files.filter(f => /\.zip$/i.test(f.path)).map(f => f.path)];
      if (!loose.length) {
        show('zip は 1 つずつ選んでください。', true);
        return;
      }
      // 検査に要るのは .eve と .txt の中身だけ。ほかは名前だけ（素材があるかを確かめるため）
      const { blob, count } = await pack(loose, path => /\.(eve|txt)$/i.test(path));
      const name = folder ? `フォルダ「${folder}」` : count === 1 ? loose[0].path : `${count} 個のファイル`;
      current = { blob, name, packed: true, skipped };
    }
    check(current);
  }

  // ---- 依存データの保存（IndexedDB。このサイトのチェッカーだけが使う） ----
  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('srcsite-check', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('deps', { keyPath: 'id', autoIncrement: true });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function store(mode, action) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('deps', mode);
        const request = action(tx.objectStore('deps'));
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }
  function listDependencies() {
    return store('readonly', s => s.getAll()).catch(() => []);
  }

  async function addDependency(files, skipped, folder) {
    if (!files.length) {
      depsStatus.textContent = skipped.length ? `ファイルを読めませんでした（${skipped.length} 個）。` : 'ファイルがありません。';
      return;
    }
    depsStatus.textContent = '依存データを読んでいます…';
    try {
      const { isDependencyText, trimArchive } = await precheck();
      let item;
      if (files.length === 1 && /\.zip$/i.test(files[0].path)) {
        const trimmed = await trimArchive(files[0].file);
        item = { name: files[0].path, blob: trimmed.blob, files: trimmed.files, texts: trimmed.texts };
      } else {
        const texts = files.filter(f => isDependencyText(f.path)).length;
        const { blob, count } = await pack(files, isDependencyText);
        item = { name: folder ? `フォルダ「${folder}」` : `${count} 個のファイル`, blob, files: count, texts };
      }
      if (!item.texts) {
        depsStatus.textContent = `${item.name} には System の .txt も Lib の .eve もありません（素材の名前だけを使います）。`;
      } else {
        depsStatus.textContent = `${item.name} を足しました（System・Lib のファイル ${item.texts} 個）。`;
      }
      await store('readwrite', s => s.add({ ...item, enabled: true, added: Date.now() }));
    } catch (err) {
      depsStatus.textContent = `依存データを足せませんでした: ${err.message ?? err}`;
    }
    renderDependencies();
  }

  async function renderDependencies() {
    const items = await listDependencies();
    depList.replaceChildren(...items.map(item => {
      const li = document.createElement('li');
      const label = li.appendChild(document.createElement('label'));
      label.className = 'check';
      const box = label.appendChild(document.createElement('input'));
      box.type = 'checkbox';
      box.checked = item.enabled;
      box.addEventListener('change', () => store('readwrite', s => s.put({ ...item, enabled: box.checked })));
      label.append(` ${item.name}`);
      const meta = li.appendChild(document.createElement('span'));
      meta.className = 'muted';
      meta.textContent = `System・Lib ${item.texts} 個・ファイル ${item.files} 個`;
      const remove = li.appendChild(document.createElement('button'));
      remove.type = 'button';
      remove.className = 'link';
      remove.textContent = '外す';
      remove.addEventListener('click', async () => {
        await store('readwrite', s => s.delete(item.id));
        renderDependencies();
      });
      return li;
    }));
  }

  // ---- 確かめる ----
  async function check({ blob, name, packed, skipped }) {
    running = true;
    recheck.hidden = true;
    summary.hidden = true;
    lintBox.hidden = true;
    progress.hidden = false;
    progress.value = 0;
    try {
      show('zip の中身を調べています…');
      const { survey } = await precheck();
      let s;
      try {
        s = await survey(blob);
      } catch (err) {
        show(`zip を読めません: ${err.message ?? err}`, true);
        return;
      }
      const kinds = { scenario: 'シナリオ（イベントとデータ）', data: 'データだけ（イベントなし）', other: 'SRC のデータもイベントも見つかりません' };
      const rows = [
        ['対象', name],
        ['中身', `${kinds[s.kind]}・ファイル ${s.files} 個（.eve ${s.eves} 個・データ ${s.dataFiles.length} 個）`],
      ];
      if (skipped.length) {
        rows.push(['飛ばしたもの', `${skipped.length} 個（一緒に渡した zip・読めないファイル）: ${skipped.slice(0, 5).join('、')}${skipped.length > 5 ? ' ほか' : ''}`]);
      }
      if (!packed) {
        rows.push(['投稿', s.uploadable ? 'この zip はそのまま投稿できます' : `このままでは投稿できません: ${s.uploadReason}`]);
      } else {
        // フォルダ・ファイルは名前で分かる規則（実行ファイル・パス・.eve の有無）だけ。大きさと圧縮率は zip にしてから決まる
        rows.push(['投稿', s.uploadable ? 'zip にすれば投稿できます（大きさは zip にしてから確かめます）' : `zip にしても投稿できません: ${s.uploadReason}`]);
      }
      if (s.kind === 'other') {
        showSummary(rows);
        show('SRC のデータ（robot.txt・pilot.txt など）もイベント（.eve）も見つかりませんでした。', true);
        return;
      }
      const chosenPacks = packs.filter(p => [...form.querySelectorAll('input[name=pack]:checked')].some(c => c.value === p.id));
      const deps = (await listDependencies()).filter(d => d.enabled);
      const used = [...chosenPacks.map(p => p.title), ...deps.map(d => d.name)];
      rows.push(['汎用データ', used.length ? used.join('、') : 'なし']);
      const found = await SrcLint.run(blob, {
        systemArchives: [...chosenPacks.map(p => p.url), ...deps.map(d => d.blob)],
        assets: form.assets.checked,
        show,
        progress,
        cancel,
      });
      if (!found) {
        showSummary(rows);
        show('確かめるのをやめました。');
        return;
      }
      rows.push(['結果', found.length ? SrcLint.summarize(found) : '問題は見つかりませんでした']);
      showSummary(rows);
      if (found.length) {
        SrcLint.renderTable(lintBox, found);
      }
      show(s.kind === 'data' ? 'データを確かめました（イベントが無いので、イベントとラベルは確かめていません）。' : 'シナリオを確かめました。');
    } finally {
      running = false;
      progress.hidden = true;
      recheck.hidden = !current;
    }
  }

  function showSummary(rows) {
    summary.replaceChildren(...rows.flatMap(([k, v]) => {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      return [dt, dd];
    }));
    summary.hidden = false;
  }
})();
