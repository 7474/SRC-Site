// パックの zip への反映（/my/packs/:id）。承認したファイルを、このブラウザで 1 つの zip に組んで上げる（docs/resources.md）
// 組み方は /static/packbuild.js（src/client/packbuild.ts）、アップロードは public/uploader.js
(() => {
  const form = document.getElementById('pack-build');
  if (!form) {
    return;
  }
  const { json, postJson, putPart } = window.SrcUpload;
  const status = form.querySelector('.status');
  const progress = form.querySelector('progress');
  const button = form.querySelector('button[type=submit]');
  const pack = encodeURIComponent(form.dataset.pack);
  const show = (text, error) => {
    status.textContent = text;
    status.classList.toggle('error', Boolean(error));
  };

  async function build() {
    button.disabled = true;
    progress.hidden = false;
    progress.value = 0;
    try {
      const { buildPack, partWriter } = await import('/static/packbuild.js');
      show('パックに入れるファイルを確かめています…');
      const plan = await json(await fetch(`/api/packs/${pack}/plan`));
      if (plan.problem) {
        show(plan.problem, true);
        return;
      }
      const created = await postJson(`/api/packs/${pack}/builds`, { revision: plan.revision, size: plan.size });
      const parts = [];
      let sent = 0;
      const writer = partWriter(created.partSize, async (n, body) => {
        const etag = await putPart(`${created.partsBase}/parts/${n}`, new Blob([body]));
        parts.push({ partNumber: n, etag });
        sent += body.length;
      });
      await buildPack(plan, {
        write: chunk => writer.write(chunk),
        progress(done, total, path) {
          progress.value = done / total * 100;
          show(`zip を組んで上げています…（${done}／${total} ファイル、${Math.round(sent / 1024 / 1024)} MB 送った）${path}`);
        },
      });
      await writer.flush();
      show('サイトが zip の目次を確かめています…');
      const done = await postJson(`${created.partsBase}/complete`, { parts });
      show(`zip に反映しました（版 ${done.version}）。`);
      setTimeout(() => location.replace(location.pathname + '?saved=1'), 1000);
    } catch (err) {
      show(String(err.message || err), true);
    } finally {
      button.disabled = false;
    }
  }

  form.addEventListener('submit', e => {
    e.preventDefault();
    build();
  });
  if (form.dataset.autostart === '1') {
    build();
  }
})();
