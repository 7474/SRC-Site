// srcsharp lint（7474/SRC の SRCLintWeb、/lint/srclint.js）の実行と結果の表示。投稿の画面（upload.js）とチェッカー（check.js）が使う
(() => {
  // lint の実行環境（WebAssembly）を先に読み込んでおく。読み込めなければ null（呼び出し元は lint を飛ばす）
  const lintModule = import('/lint/srclint.js').then(m => (m.preload(), m)).catch(() => null);

  // lint の段階（srclint.js の PHASES）ごとの名前と、進捗バーでの重み（手元で計った時間のおおよその割合）
  const PHASES = {
    scenario: { label: 'zip からデータとイベントを取り出しています', weight: 10 },
    system: { label: '汎用データを読んでいます', weight: 35 },
    runtime: { label: '検査の準備をしています', weight: 10 },
    data: { label: 'データとイベントを検査しています', weight: 30 },
    analyze: { label: 'ラベルと include を確かめています', weight: 10 },
    assets: { label: '素材のファイルを確かめています', weight: 5 },
  };
  const KINDS = { error: 'エラー', warning: '警告', info: '素材' };
  const ORDER = { error: 0, warning: 1, info: 2 };

  /**
   * lint をかける。進み具合（段階・扱っているファイル・経過時間）を show と progress に出し、cancel のボタンで止められる。
   * 結果の diagnostics（ファイルの名前から zip の最上位のフォルダを省く）を返す。止めたら null、lint を使えなければ空
   * @param {Blob} file
   * @param {{ systemArchives: string[], assets: boolean, show: (text: string) => void, progress: HTMLProgressElement, cancel: HTMLElement }} options
   */
  async function run(file, { systemArchives, assets, show, progress, cancel }) {
    const started = Date.now();
    let last = null;
    const render = () => {
      const seconds = Math.floor((Date.now() - started) / 1000);
      if (!last) {
        show(`データとイベントを確かめています（${seconds} 秒）…`);
        return;
      }
      // 済んだ段階の重み ＋ いまの段階の重み × 段階の中の割合
      let value = 0;
      for (const [name, p] of Object.entries(PHASES)) {
        if (name === last.phase) {
          value += p.weight * (last.total ? last.done / last.total : 0);
          break;
        }
        value += p.weight;
      }
      progress.value = value;
      const phase = PHASES[last.phase] ?? { label: last.phase };
      const count = last.total > 1 ? `（${Math.min(last.done + 1, last.total)}／${last.total}）` : '';
      // パックの zip（/files/packs/<id>/<版>.zip）はパックの名前だけにする
      const target = last.file.replace(/^([^/:]+)\/[^/:]+\.zip/, '$1');
      show(`${phase.label}${count}… ${seconds} 秒\n${target}`);
    };
    progress.value = 0;
    render();
    const timer = setInterval(render, 1000);
    const controller = new AbortController();
    const abort = () => controller.abort();
    cancel.hidden = false;
    cancel.addEventListener('click', abort);
    try {
      const m = await lintModule;
      if (!m) {
        return [];
      }
      const result = await m.lintZip(file, {
        systemArchives,
        assets,
        signal: controller.signal,
        onProgress: p => {
          last = p;
          render();
        },
      });
      // zip の最上位のフォルダ（シナリオのフォルダ）は、どの行も同じなので省く
      const prefix = result.root ? result.root + '/' : '';
      return result.diagnostics.map(d => ({ ...d, file: d.file.startsWith(prefix) ? d.file.slice(prefix.length) : d.file }));
    } catch (err) {
      if (controller.signal.aborted) {
        return null;
      }
      console.warn('lint に失敗しました', err);
      return [];
    } finally {
      clearInterval(timer);
      cancel.hidden = true;
      cancel.removeEventListener('click', abort);
    }
  }

  /** 結果の表を box に出す（エラー・警告・素材の順。200 件まで） */
  function renderTable(box, found) {
    const problems = [...found].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
    const table = document.createElement('table');
    const head = table.createTHead().insertRow();
    for (const h of ['ファイル', '行', '種類', '内容']) {
      head.appendChild(document.createElement('th')).textContent = h;
    }
    const body = table.createTBody();
    for (const d of problems.slice(0, 200)) {
      const row = body.insertRow();
      row.className = `sev-${d.severity}`;
      const cells = [d.file, d.line, KINDS[d.severity] ?? d.severity, d.message + (d.source && d.severity !== 'info' ? `（${d.source}）` : '')];
      cells.forEach((v, i) => {
        const td = row.insertCell();
        td.textContent = String(v);
        if (i === 0) td.className = 'file';
      });
    }
    box.replaceChildren(table);
    if (problems.length > 200) {
      box.appendChild(document.createElement('p')).textContent = `ほか ${problems.length - 200} 件`;
    }
    box.hidden = false;
  }

  /** 種類ごとの件数（例: エラー 1 件・警告 3 件・素材 2 件） */
  function summarize(found) {
    return Object.entries(KINDS)
      .map(([severity, label]) => [label, found.filter(d => d.severity === severity).length])
      .filter(([, n]) => n > 0)
      .map(([label, n]) => `${label} ${n} 件`)
      .join('・');
  }

  /**
   * 汎用データ（依存データ）が足りないと出る問題を、種類ごとに名前をまとめる。
   * スペシャルパワー（データの参照）、Call・Goto の飛び先のラベル、include するファイル（汎用戦闘アニメなどの Lib にあることが多い）
   * @returns {{ kind: string, names: string[], count: number }[]}
   */
  function unresolved(found) {
    const kinds = [
      { kind: 'スペシャルパワー', pattern: /^(.+)というスペシャルパワーは存在しません/ },
      { kind: 'ラベル', pattern: /^ラベル「(.+)」が見つかりません/ },
      { kind: 'include するファイル', pattern: /^include するファイル「(.+)」が見つかりません/ },
    ];
    return kinds.map(({ kind, pattern }) => {
      const hits = found.map(d => d.message.match(pattern)).filter(Boolean);
      return { kind, names: [...new Set(hits.map(m => m[1]))], count: hits.length };
    }).filter(g => g.count > 0);
  }

  window.SrcLint = { run, renderTable, summarize, unresolved };
})();
