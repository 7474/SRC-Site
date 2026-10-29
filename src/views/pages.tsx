import type { Child } from 'hono/jsx';
import { Notice } from './layout';
import { formatDate, formatSize } from '../lib/util';
import { resolveRequires, type PackRow } from '../lib/catalog';

// データビューア（/viewer/）でアーカイブを開く URL（7474/SRC の docs/gui/dataviewer.md）。ID は src/routes/viewer.ts の viewerId
export const viewerUrl = (type: 'scenarios' | 'packs', id: string) => `/viewer/archive?id=${encodeURIComponent(`${type}/${id}`)}`;

export type ListItem = {
  slug: string; title: string; author: string | null; handle: string; updated_at: number;
  size: number | null; description: string | null; plays: number | null;
};

export function ScenarioList(props: { items: ListItem[]; empty?: string }) {
  if (props.items.length === 0) {
    return <p class="muted">{props.empty ?? 'まだありません。'}</p>;
  }
  return (
    <ul class="scenario-list">
      {props.items.map(s => (
        <li>
          <a class="title" href={`/scenarios/${s.slug}`}>{s.title}</a>
          <div class="meta">
            {s.author ?? s.handle} ・ {formatDate(s.updated_at)}{s.size != null && <> ・ {formatSize(s.size)}</>}
            {s.plays ? <> ・ {s.plays} 回プレイ</> : null}
          </div>
          {s.description && <p class="summary">{s.description.slice(0, 120)}</p>}
        </li>
      ))}
    </ul>
  );
}

export function Home(props: { q: string; latest: ListItem[]; popular: ListItem[] }) {
  return (
    <>
      {props.q ? (
        <section>
          <h1>「{props.q}」の検索結果</h1>
          <ScenarioList items={props.latest} empty="見つかりませんでした。" />
        </section>
      ) : (
        <>
          <section class="intro">
            <p>SRC（Simulation RPG Construction）のシナリオを投稿・配布するサイトです。ブラウザ版の SRC#Web ですぐ遊べ、zip をダウンロードして手元の SRC・SRC# でも遊べます。</p>
            <div class="actions">
              <a class="button primary" href="/play/">SRC#Web で遊ぶ</a>
              <a class="button" href="/my/scenarios/new">シナリオを投稿する</a>
              <a class="button" href="/packs">素材を投稿する</a>
            </div>
            <p class="tools">道具：<a href="/check">チェッカー</a>（シナリオ・データの書き方を確かめる）・<a href="/viewer/">データビューア</a>（データ・画像・音を見る）・<a href="/packs">共有パック</a>（シナリオが使う素材。だれでも作れ、投稿できる）</p>
          </section>
          {props.popular.length > 0 && (
            <section>
              <h2>人気（7 日間）</h2>
              <ScenarioList items={props.popular} />
            </section>
          )}
          <section>
            <h2>新着</h2>
            <ScenarioList items={props.latest} empty="まだありません。最初のシナリオを投稿してみてください。" />
          </section>
        </>
      )}
    </>
  );
}

export type VersionItem = { id: number; number: number; state: string; size: number; created_at: number; published_at: number | null; note: string | null; inspect_note: string | null };
export type PackItem = { id: string; title: string; source_name: string };

export function ScenarioPage(props: {
  s: { slug: string; title: string; author: string | null; description: string | null; license: string | null; handle: string; hidden: number; hidden_reason: string | null; visibility: string; tags: string[] };
  latest: (VersionItem & { root: string | null; eve: string | null; manifest: { files: number; totalSize: number; documents: string[] } | null }) | null;
  versions: VersionItem[];
  packs: PackItem[];
  canEdit: boolean;
  isAdmin: boolean;
  reportUrl: string | null;
}) {
  const { s, latest } = props;
  return (
    <article class="scenario">
      <h1>{s.title}</h1>
      <p class="meta">
        {s.author && s.author !== s.handle && <>作者: {s.author} ・ </>}投稿: <a href={`/users/${s.handle}`}>{s.handle}</a>
        {latest && <> ・ 第 {latest.number} 版（{formatDate(latest.published_at ?? latest.created_at)}）</>}
        {s.visibility === 'unlisted' && ' ・ 限定公開'}
      </p>
      {s.hidden ? <Notice kind="error">運営により公開を止めています。{s.hidden_reason}</Notice> : null}
      {!latest && <p class="muted">公開している版がありません。</p>}
      {(latest || props.canEdit) && (
        <div class="actions">
          {latest && <a class="button primary" href={`/play/?play=${encodeURIComponent(s.slug)}`}>SRC#Web で遊ぶ</a>}
          {latest && <a class="button" href={`/scenarios/${s.slug}/download`}>ダウンロード（{formatSize(latest.size)}）</a>}
          {latest && s.visibility === 'public' && !s.hidden && <a class="button" href={viewerUrl('scenarios', s.slug)}>データビューアで見る</a>}
          {props.canEdit && <a class="button" href={`/my/scenarios/${s.slug}`}>編集・新しい版を上げる</a>}
        </div>
      )}
      {s.description && <section><h2>説明</h2><p class="pre">{s.description}</p></section>}
      {s.tags.length > 0 && <p class="tags">{s.tags.map(t => <a class="tag" href={`/?q=${encodeURIComponent(t)}`}>{t}</a>)}</p>}
      {s.license && <section><h2>ライセンス・配布の条件</h2><p class="pre">{s.license}</p></section>}
      {latest?.manifest && (
        <section>
          <h2>中身</h2>
          <p>{latest.manifest.files} ファイル・展開後 {formatSize(latest.manifest.totalSize)}。最初に実行するシナリオ: {latest.eve ?? '（選ぶ）'}</p>
          {latest.manifest.documents.length > 0 && <p>同梱の文書: {latest.manifest.documents.join('、')}（SRC#Web の「文書」から読めます）</p>}
        </section>
      )}
      <section>
        <h2>一緒に使う共有パック</h2>
        {props.packs.length === 0 ? <p class="muted">ありません。</p> : (
          <ul>{props.packs.map(p => <li><a href={`/packs/${p.id}`}>{p.title}</a> <span class="muted">{p.source_name}</span></li>)}</ul>
        )}
        <p class="muted small">BGM（版権曲など）はサイトでは配っていません。お持ちの MIDI・MP3 を zip にして SRC#Web の「アーカイブを追加」の素材の欄から入れると、どのシナリオでも使えます。</p>
      </section>
      <section>
        <h2>版</h2>
        <ul class="versions">
          {props.versions.filter(v => v.state === 'published').map(v => (
            <li>第 {v.number} 版 ・ {formatDate(v.published_at ?? v.created_at)} ・ {formatSize(v.size)}{v.note && <> ・ {v.note}</>}</li>
          ))}
        </ul>
      </section>
      {props.reportUrl && (
        <p class="report small"><a href={props.reportUrl} target="_blank" rel="noopener">このシナリオを通報する（Google フォーム）</a></p>
      )}
      {props.isAdmin && !s.hidden && (
        <form method="post" action={`/admin/scenarios/${s.slug}/hide`} class="report compact">
          <input name="reason" placeholder="止める理由（公開されます）" /> <button type="submit">運営: 公開を止める</button>
        </form>
      )}
    </article>
  );
}

export function Turnstile(props: { siteKey?: string }) {
  if (!props.siteKey) {
    return null;
  }
  return (
    <>
      <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
      <div class="cf-turnstile" data-sitekey={props.siteKey}></div>
    </>
  );
}

export function UserPage(props: { handle: string; items: ListItem[] }) {
  return (
    <section>
      <h1>{props.handle} さんのシナリオ</h1>
      <ScenarioList items={props.items} />
    </section>
  );
}

export type MyPack = { id: string; title: string; role: string; pending: number; dirty: number };
export type MySubmission = {
  id: number; pack_id: string; pack_title: string; title: string; state: string; created_at: number;
  reviewed_at: number | null; review_note: string | null; inspect_note: string | null; reflected: number;
};

export function MePage(props: {
  handle: string; termsAccepted: boolean; items: (ListItem & { visibility: string; hidden: number })[]; error?: string; saved?: boolean;
  packs?: MyPack[]; submissions?: MySubmission[];
}) {
  return (
    <>
      <section>
        <h1>設定</h1>
        {props.error && <Notice kind="error">{props.error}</Notice>}
        {props.saved && <Notice>保存しました。</Notice>}
        <form method="post" action="/my" class="form">
          <label>表示名（英数字・_・-、3〜24 文字。投稿者の頁の URL にも使います）
            <input name="handle" value={props.handle} pattern="[A-Za-z0-9_\-]{3,24}" required />
          </label>
          <label class="check">
            <input type="checkbox" name="terms" value="1" checked={props.termsAccepted} disabled={props.termsAccepted} />
            <a href="/about/terms" target="_blank">利用規約</a>に同意します（投稿に必要です）
          </label>
          <button type="submit">保存</button>
        </form>
        <form method="post" action="/auth/logout"><button type="submit" class="link">ログアウト</button></form>
      </section>
      <section>
        <h2>投稿したシナリオ</h2>
        <p><a class="button" href="/my/scenarios/new">新しく投稿する</a></p>
        {props.items.length === 0 ? <p class="muted">まだありません。</p> : (
          <ul class="scenario-list">
            {props.items.map(s => (
              <li>
                <a class="title" href={`/scenarios/${s.slug}`}>{s.title}</a>
                <span class="list-badges">
                  {s.visibility !== 'public' && <span class="badge">{s.visibility === 'unlisted' ? '限定公開' : '非公開'}</span>}
                  {s.hidden ? <span class="badge stopped">運営が停止</span> : null}
                </span>
                <div class="meta">{formatDate(s.updated_at)} ・ <a href={`/my/scenarios/${s.slug}`}>編集・新しい版を上げる</a></div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h2>管理しているパック</h2>
        <p><a class="button" href="/my/packs/new">パックを作る</a></p>
        {(props.packs ?? []).length === 0 ? <p class="muted">ありません。</p> : (
          <ul class="scenario-list">
            {props.packs!.map(p => (
              <li>
                <a class="title" href={`/my/packs/${p.id}`}>{p.title}</a>
                <span class="list-badges">
                  {p.role === 'owner' && <span class="badge">作成者</span>}
                  {p.pending > 0 && <span class="badge stopped">承認待ち {p.pending}</span>}
                  {p.dirty ? <span class="badge">zip に未反映</span> : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h2>パックへの投稿</h2>
        {(props.submissions ?? []).length === 0 ? <p class="muted">まだありません。素材は<a href="/packs">共有パック</a>の頁から投稿します。</p> : (
          <ul class="scenario-list">
            {props.submissions!.map(s => (
              <li>
                <a class="title" href={`/my/submissions/${s.id}`}>{s.title}</a>
                <span class="list-badges"><span class={`badge${s.state === 'rejected' ? ' stopped' : ''}`}>{SUBMISSION_STATES[s.state] ?? s.state}</span></span>
                <div class="meta">
                  <a href={`/packs/${s.pack_id}`}>{s.pack_title}</a> ・ 投稿 {formatDate(s.created_at)}
                  {s.reviewed_at && <> ・ {s.state === 'approved' ? '承認' : s.state === 'rejected' ? '却下' : '更新'} {formatDate(s.reviewed_at)}</>}
                  {s.state === 'approved' && (s.reflected ? ' ・ パックの zip に入っている' : ' ・ zip への反映待ち')}
                </div>
                {(s.review_note || s.inspect_note) && <p class="summary small error">{s.inspect_note ? `検査で弾かれました: ${s.inspect_note}` : `却下の理由: ${s.review_note}`}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

export const SUBMISSION_STATES: Record<string, string> = {
  uploading: 'アップロード中', inspecting: '検査中', pending: '承認待ち', approved: '承認', rejected: '却下・弾かれた', withdrawn: '取り下げ', retired: 'すべて差し替え済み',
};

export type ScenarioForm = { slug: string; title: string; author: string; description: string; license: string; tags: string; visibility: string };

export function ScenarioFields(props: { v: ScenarioForm; isNew: boolean }) {
  const v = props.v;
  return (
    <>
      {props.isNew && (
        <label>ID（URL と SRC#Web の起動に使う。英小文字・数字・-、3〜40 文字。後から変えられません）
          <input name="slug" value={v.slug} pattern="[a-z0-9][a-z0-9\-]{1,38}[a-z0-9]" required />
        </label>
      )}
      <label>題名<input name="title" value={v.title} maxlength={100} required /></label>
      <label>作者（投稿者と違う場合。空なら表示名）<input name="author" value={v.author} maxlength={100} /></label>
      <label>説明<textarea name="description" rows={6} maxlength={5000}>{v.description}</textarea></label>
      <label>ライセンス・配布の条件（使った素材の出典もここに）<textarea name="license" rows={4} maxlength={5000}>{v.license}</textarea></label>
      <label>タグ（空白区切り）<input name="tags" value={v.tags} maxlength={200} /></label>
      <label>公開
        <select name="visibility">
          <option value="public" selected={v.visibility === 'public'}>公開</option>
          <option value="unlisted" selected={v.visibility === 'unlisted'}>限定公開（一覧に出さない。URL を知っている人は遊べる）</option>
          <option value="private" selected={v.visibility === 'private'}>非公開</option>
        </select>
      </label>
    </>
  );
}

export function NewScenarioPage(props: { v: ScenarioForm; error?: string }) {
  return (
    <section>
      <h1>シナリオを投稿する</h1>
      <p>まずシナリオの情報を登録し、次の画面で zip を上げます。投稿したものはすぐに公開されます（運営の確認はありません）。内容の責任は投稿者にあります（<a href="/about/terms">利用規約</a>）。</p>
      {props.error && <Notice kind="error">{props.error}</Notice>}
      <form method="post" action="/my/scenarios/new" class="form">
        <ScenarioFields v={props.v} isNew={true} />
        <button type="submit">次へ</button>
      </form>
    </section>
  );
}

export function EditPage(props: {
  slug: string; v: ScenarioForm; versions: (VersionItem & { root: string | null; eve: string | null; requires: string; excludes: string })[];
  packs: { id: string; title: string; is_default: number; priority: number; withdrawn: number; version: string }[]; error?: string; saved?: boolean; turnstileKey?: string; directUpload: boolean;
}) {
  const latestPublished = props.versions.find(v => v.state === 'published');
  const requires = latestPublished ? JSON.parse(latestPublished.requires) as string[] : [];
  const excludes = latestPublished ? JSON.parse(latestPublished.excludes) as string[] : [];
  // lint が汎用データ（Data/System の sp.txt など）を読むパック。遊ぶときに重ねるものと同じ
  const systemArchives = resolveRequires(props.packs as PackRow[], requires, excludes)
    .map(id => props.packs.find(p => p.id === id)!)
    .map(p => `/files/packs/${p.id}/${p.version}.zip`);
  return (
    <>
      <section>
        <h1>{props.v.title} の編集</h1>
        <p><a href={`/scenarios/${props.slug}`}>シナリオの頁へ</a></p>
        {props.error && <Notice kind="error">{props.error}</Notice>}
        {props.saved && <Notice>保存しました。</Notice>}
      </section>
      <section>
        <h2>新しい版を上げる</h2>
        <p>シナリオのフォルダを zip にしたものを選んでください（1 GB まで）。上げる前に、ブラウザの中で zip の中身（.eve があるか、実行ファイルが無いか など）を確かめます。上げると、すぐに公開されます。</p>
        <p>あわせて、データ・イベントの書き方（srcsharp lint と同じ検査）、Call の飛び先のラベルや include するファイルがあるか、画像・音などの素材のファイルがあるかを確かめられます。どこまで確かめるかは下で選べます。素材が無いことは知らせるだけで、上げるのは止めません。</p>
        <form id="upload" class="form" data-slug={props.slug} data-create-url={`/api/scenarios/${props.slug}/versions`} data-fields="note" data-direct={props.directUpload ? '1' : '0'} data-system-archives={JSON.stringify(systemArchives)}>
          <input type="file" name="file" accept=".zip,application/zip" required />
          <label>この版の説明（任意）<input name="note" maxlength={200} /></label>
          <label>上げる前の確かめ
            <select name="lintLevel">
              <option value="stop">問題があれば止める（確かめてから上げる）</option>
              <option value="warn">問題を表示して、そのまま上げる</option>
              <option value="off">確かめない</option>
            </select>
          </label>
          <label class="check"><input type="checkbox" name="lintAssets" checked /> 素材（画像・音・マップ）のファイルがあるかも見る（知らせるだけ）</label>
          <Turnstile siteKey={props.turnstileKey} />
          <button type="submit">上げる</button>
          <progress hidden max={100} value={0}></progress>
          <p class="status" aria-live="polite"></p>
          <button type="button" class="lint-cancel" hidden>確かめるのをやめる</button>
          <div class="lint" hidden></div>
          <label class="check lint-confirm" hidden><input type="checkbox" name="lintConfirm" /> 問題があっても上げる</label>
        </form>
        <script src="/static/lint-ui.js" defer></script>
        <script src="/static/uploader.js" defer></script>
        <script src="/static/upload.js" defer></script>
      </section>
      <section>
        <h2>版</h2>
        {props.versions.length === 0 ? <p class="muted">まだありません。上の「新しい版を上げる」から zip を上げてください。</p> : (
          <ul class="version-list">
            {props.versions.map(v => (
              <li>
                <div class="version-head">
                  <strong>第 {v.number} 版</strong>
                  <span class={`badge${v.state === 'rejected' ? ' stopped' : ''}`}>{STATE_LABELS[v.state] ?? v.state}</span>
                  <span class="meta">{formatSize(v.size)} ・ {formatDate(v.created_at)}{v.note && <> ・ {v.note}</>}</span>
                  {(v.state === 'published' || v.state === 'rejected') && (
                    <form method="post" action={`/my/versions/${v.id}/delete`} class="version-delete" onsubmit="return confirm('この版を消しますか？')">
                      <button type="submit" class="link">この版を消す</button>
                    </form>
                  )}
                </div>
                {v.inspect_note && <div class="small error">{v.inspect_note}</div>}
                {v.state === 'published' && (
                  <form method="post" action={`/my/versions/${v.id}/settings`} class="compact">
                    <label>フォルダ（root）<input name="root" value={v.root ?? ''} /></label>
                    <label>最初の .eve<input name="eve" value={v.eve ?? ''} /></label>
                    <button type="submit">変える</button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      {latestPublished && (
        <section>
          <h2>一緒に使う共有パック（最新の版）</h2>
          <form method="post" action={`/my/versions/${latestPublished.id}/packs`} class="form">
            {props.packs.map(p => (
              <label class="check">
                <input type="checkbox" name="pack" value={p.id} checked={p.is_default ? !excludes.includes(p.id) : requires.includes(p.id)} />
                {p.title}{p.is_default ? '（既定）' : ''}
              </label>
            ))}
            <button type="submit">保存</button>
          </form>
        </section>
      )}
      <section>
        <h2>シナリオの情報</h2>
        <form method="post" action={`/my/scenarios/${props.slug}`} class="form">
          <ScenarioFields v={props.v} isNew={false} />
          <button type="submit">保存</button>
        </form>
      </section>
      <section>
        <h2>シナリオを消す</h2>
        <form method="post" action={`/my/scenarios/${props.slug}/delete`} onsubmit="return confirm('シナリオとすべての版を消します。よろしいですか？')">
          <button type="submit" class="danger">消す</button>
        </form>
      </section>
    </>
  );
}

const STATE_LABELS: Record<string, string> = {
  uploading: 'アップロード中', inspecting: '検査中', published: '公開', rejected: '弾かれた', withdrawn: '取り下げ',
};

export function Simple(props: { title: string; children: Child }) {
  return <section><h1>{props.title}</h1>{props.children}</section>;
}
