// データ・シナリオのチェッカー（/check）。選ぶかドロップした zip・フォルダ・ファイルを、ブラウザの中だけで確かめる。
// 1. zip の目次を調べ、中身の種類（シナリオ・データだけ・どちらでもない）を決める（precheck.js の survey）
// 2. 種類に合わせて srcsharp lint をかける（lint-ui.js）。結果は投稿の画面と同じ表で出す
// zip でないもの（フォルダ・ファイル）は、.eve と .txt の中身と、ほかのファイルの名前だけを zip にまとめてから確かめる（素材は名前で探すため）
(() => {
  const form = document.getElementById('check');
  if (!form) {
    return;
  }
  const zone = form.querySelector('.dropzone');
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

  form.file.addEventListener('change', () => fromFiles([...form.file.files].map(f => ({ path: f.name, file: f }))));
  form.folder.addEventListener('change', () => fromFiles([...form.folder.files].map(f => ({ path: f.webkitRelativePath || f.name, file: f }))));
  recheck.addEventListener('click', () => current && check(current));

  // ドロップ（フォルダは中をたどる）
  for (const type of ['dragenter', 'dragover']) {
    zone.addEventListener(type, e => {
      e.preventDefault();
      zone.classList.add('over');
    });
  }
  zone.addEventListener('dragleave', e => {
    if (!zone.contains(e.relatedTarget)) {
      zone.classList.remove('over');
    }
  });
  zone.addEventListener('drop', async e => {
    e.preventDefault();
    zone.classList.remove('over');
    const entries = [...e.dataTransfer.items].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
    if (entries.length) {
      const files = [];
      for (const entry of entries) {
        await walk(entry, '', files);
      }
      fromFiles(files);
    } else {
      fromFiles([...e.dataTransfer.files].map(f => ({ path: f.name, file: f })));
    }
  });

  async function walk(entry, prefix, out) {
    if (entry.isFile) {
      out.push({ path: prefix + entry.name, file: await new Promise((resolve, reject) => entry.file(resolve, reject)) });
      return;
    }
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) {
        break;
      }
      for (const child of batch) {
        await walk(child, prefix + entry.name + '/', out);
      }
    }
  }

  async function fromFiles(files) {
    if (running || !files.length) {
      return;
    }
    // zip 1 つならそのまま。ほかはまとめる
    if (files.length === 1 && /\.zip$/i.test(files[0].path)) {
      current = { blob: files[0].file, name: files[0].path, packed: false };
    } else {
      show('ファイルをまとめています…');
      const { buildZip } = await import('/static/precheck.js');
      const entries = [];
      for (const { path, file } of files) {
        if (/\.zip$/i.test(path)) {
          continue;
        }
        // 検査に要るのは .eve と .txt の中身だけ。ほかは名前だけ（素材があるかを確かめるため）
        const data = /\.(eve|txt)$/i.test(path) ? new Uint8Array(await file.arrayBuffer()) : new Uint8Array(0);
        entries.push({ name: path.replace(/\\/g, '/'), data });
      }
      if (!entries.length) {
        show('zip は 1 つずつ選んでください。', true);
        return;
      }
      current = { blob: buildZip(entries), name: files.length === 1 ? files[0].path : `${entries.length} 個のファイル`, packed: true };
    }
    check(current);
  }

  async function check({ blob, name, packed }) {
    running = true;
    recheck.hidden = true;
    summary.hidden = true;
    lintBox.hidden = true;
    progress.hidden = false;
    progress.value = 0;
    try {
      show('zip の中身を調べています…');
      const { survey } = await import('/static/precheck.js');
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
      if (!packed) {
        rows.push(['投稿', s.uploadable ? 'この zip はそのまま投稿できます' : `このままでは投稿できません: ${s.uploadReason}`]);
      }
      if (s.kind === 'other') {
        showSummary(rows);
        show('SRC のデータ（robot.txt・pilot.txt など）もイベント（.eve）も見つかりませんでした。', true);
        return;
      }
      const systemArchives = packs.filter(p => [...form.querySelectorAll('input[name=pack]:checked')].some(c => c.value === p.id)).map(p => p.url);
      const found = await SrcLint.run(blob, { systemArchives, assets: form.assets.checked, show, progress, cancel });
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
