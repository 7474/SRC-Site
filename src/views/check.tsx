// データ・シナリオのチェッカー（/check）。ログインは要らない。ファイルはブラウザの外に出さない（public/check.js）
export type CheckPack = { id: string; title: string; is_default: number; version: string };

export function CheckPage(props: { packs: CheckPack[] }) {
  const packs = props.packs.map(p => ({ id: p.id, title: p.title, url: `/files/packs/${p.id}/${p.version}.zip`, default: Boolean(p.is_default) }));
  return (
    <section>
      <h1>データ・シナリオのチェック</h1>
      <p>SRC のシナリオやデータの書き方を、ブラウザの中で確かめます（srcsharp lint と同じ検査）。ファイルはどこにも送りません。ログインも要りません。</p>
      <form id="check" class="form" data-packs={JSON.stringify(packs)} onsubmit="return false">
        <div class="dropzone" tabindex={0}>
          <p class="dropzone-title">zip・フォルダ・ファイルをここにドロップ</p>
          <p class="muted">シナリオ（.eve を含む）でも、データだけ（robot.txt・pilot.txt など）でもかまいません。中身に合わせて確かめます。</p>
          <div class="actions">
            <label class="button primary">zip・ファイルを選ぶ<input type="file" name="file" accept=".zip,.txt,.eve" multiple hidden /></label>
            <label class="button">フォルダを選ぶ<input type="file" name="folder" webkitdirectory multiple hidden /></label>
          </div>
        </div>
        <section class="deps" aria-labelledby="deps-title">
          <h2 id="deps-title">依存データ（手元の SRC 本体・データパック）</h2>
          <p class="muted">シナリオが手元の SRC 本体の System（独自のスペシャルパワーなど）や、GSC データパックなどを使うときは、そのフォルダか zip をここに足してください。System の .txt と Lib の .eve の中身と、ほかのファイルの名前だけを、このブラウザに覚えておきます（サーバには送りません）。</p>
          <div class="dropzone deps-zone" tabindex={0}>
            <p>SRC 本体・データパックのフォルダか zip をここにドロップ</p>
            <div class="actions">
              <label class="button">フォルダを足す<input type="file" name="depFolder" webkitdirectory multiple hidden /></label>
              <label class="button">zip を足す<input type="file" name="depFile" accept=".zip" multiple hidden /></label>
            </div>
          </div>
          <p class="deps-status" aria-live="polite"></p>
          <ul class="dep-list"></ul>
          <div class="web-assets" hidden>
            <p class="muted">SRC#Web（遊ぶ）に追加した素材も、依存データとして使えます。</p>
            <ul class="dep-list web-asset-list"></ul>
          </div>
        </section>
        <details class="check-options">
          <summary>確かめ方</summary>
          <fieldset>
            <legend>汎用データ（スペシャルパワー・汎用戦闘アニメのラベル・素材を探すパック）</legend>
            {packs.map(p => (
              <label class="check"><input type="checkbox" name="pack" value={p.id} checked={p.default} /> {p.title}</label>
            ))}
          </fieldset>
          <label class="check"><input type="checkbox" name="assets" checked /> 素材（画像・音・マップ）のファイルがあるかも見る（知らせるだけ）</label>
        </details>
        <button type="button" class="recheck" hidden>もう一度確かめる</button>
        <progress hidden max={100} value={0}></progress>
        <p class="status" aria-live="polite"></p>
        <button type="button" class="lint-cancel" hidden>確かめるのをやめる</button>
        <dl class="check-summary" hidden></dl>
        <div class="notice info check-hint" hidden></div>
        <div class="lint" hidden></div>
      </form>
      <h2>確かめること</h2>
      <ul>
        <li>zip の作り（実行ファイル・危ないパス・暗号化などが無いか。投稿できるかも示します）</li>
        <li>データ（robot.txt・pilot.txt・item.txt・animation.txt など）の書き方。存在しないスペシャルパワーの参照など</li>
        <li>イベント（.eve）の書き方（If と EndIf の対応など）と、Call・Goto の飛び先のラベル、include するファイル</li>
        <li>イベントとデータが参照する画像・音・マップのファイルが、zip か汎用データにあるか（無くても止めません）</li>
      </ul>
      <script src="/static/lint-ui.js" defer></script>
      <script src="/static/check.js" defer></script>
    </section>
  );
}
