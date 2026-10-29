// 共有パックの頁と、利用者が作るパック・パックへの投稿の画面（docs/resources.md）
import { Notice } from './layout';
import { SUBMISSION_STATES, Turnstile, viewerUrl } from './pages';
import { formatDate, formatSize } from '../lib/util';
import { POLICIES, policyOf, type PolicyId } from '../lib/policy';
import { mediaKind, type MediaKind } from '../lib/zip';

export type PackListItem = {
  id: string; title: string; source_name: string; size: number; is_default: number; withdrawn: number; kind: string; policy: string | null;
  r2_key: string; owner: string | null; files: number;
};

export function PacksPage(props: { packs: PackListItem[]; loggedIn: boolean }) {
  const list = (packs: PackListItem[]) => (
    <ul class="scenario-list">
      {packs.map(p => (
        <li>
          <a class="title" href={`/packs/${p.id}`}>{p.title}</a>
          <span class="list-badges">
            {p.is_default ? <span class="badge">既定</span> : null}
            {p.withdrawn ? <span class="badge stopped">取り下げ</span> : null}
            {p.kind === 'community' && !p.r2_key ? <span class="badge">まだ配っていない</span> : null}
          </span>
          <div class="meta">
            {p.kind === 'community'
              ? <>管理ポリシー: {policyOf(p.policy)?.title ?? p.policy} ・ {p.owner ? <>作成: <a href={`/users/${p.owner}`}>{p.owner}</a></> : '運営'} ・ {p.files} ファイル{p.r2_key && <> ・ {formatSize(p.size)}</>}</>
              : <>{p.source_name} ・ {formatSize(p.size)}</>}
          </div>
        </li>
      ))}
    </ul>
  );
  return (
    <section>
      <h1>共有パック</h1>
      <p>シナリオと一緒に読み込んで使う素材です。「既定」のものはすべてのシナリオで使います（シナリオの投稿者が外せます）。中身は<a href="/viewer/archives">データビューア</a>で見たり聞いたりできます。</p>
      <h2>サイトが配るパック</h2>
      {list(props.packs.filter(p => p.kind !== 'community'))}
      <h2>投稿で作るパック</h2>
      <p>利用者が作り、投稿された素材（画像・効果音・BGM・データの zip）をパックの管理者が承認してまとめたパックです。シナリオの投稿者が選んだシナリオで使います。</p>
      {props.loggedIn && <p><a class="button" href="/my/packs/new">パックを作る</a></p>}
      {list(props.packs.filter(p => p.kind === 'community'))}
    </section>
  );
}

export type PackDetail = {
  id: string; title: string; description: string | null; source_name: string; source_url: string | null; license: string; size: number; version: string;
  r2_key: string; is_default: number; withdrawn: number; updated_at: number; kind: string; policy: string | null; accepts: string;
  revision: number; built_revision: number;
};

export type SubmissionItem = { id: number; title: string; author: string | null; license: string | null; handle: string; files: number; created_at: number; reviewed_at: number | null };

export function PackPage(props: {
  p: PackDetail;
  takedowns: { target_id: string; reason: string; created_at: number }[];
  submissions: SubmissionItem[];
  managers: { handle: string; role: string }[];
  files: number;
  canSubmit: boolean;
  canManage: boolean;
  pending: number;
}) {
  const p = props.p;
  const built = p.r2_key !== '';
  const policy = policyOf(p.policy);
  return (
    <section>
      <h1>{p.title}</h1>
      {p.withdrawn ? <Notice kind="error">配布を止めています。</Notice> : null}
      {p.description && <p class="pre">{p.description}</p>}
      <div class="actions">
        {p.kind === 'community' && props.canSubmit && <a class="button primary" href={`/my/packs/${p.id}/submit`}>このパックに投稿する</a>}
        {built && !p.withdrawn && <a class="button" href={viewerUrl('packs', p.id)}>データビューアで見る</a>}
        {built && !p.withdrawn && <a class="button" href={`/files/packs/${p.id}/${p.version}.zip`} download={`${p.id}.zip`}>ダウンロード（{formatSize(p.size)}）</a>}
        {props.canManage && <a class="button" href={`/my/packs/${p.id}`}>管理{props.pending > 0 ? `（承認待ち ${props.pending}）` : ''}</a>}
      </div>
      <dl>
        {p.kind === 'community' ? (
          <>
            <dt>管理ポリシー</dt><dd>{policy?.title ?? p.policy}</dd>
            <dt>条件</dt><dd class="pre">{p.license}</dd>
            <dt>管理者</dt><dd>{props.managers.length ? props.managers.map((m, i) => <>{i > 0 && '・'}<a href={`/users/${m.handle}`}>{m.handle}</a>{m.role === 'owner' && '（作成者）'}</>) : '運営'}</dd>
            <dt>投稿</dt><dd>{p.accepts === 'anyone' ? 'だれでも投稿でき、管理者が承認する' : '管理者だけが投稿する'}</dd>
            <dt>中身</dt><dd>{props.files} ファイル{built ? <>（zip {formatSize(p.size)}・{formatDate(p.updated_at)}）</> : '（まだ配っていません）'}{p.revision !== p.built_revision && built && ' ・ 承認したものの一部はまだ zip に入っていません'}</dd>
          </>
        ) : (
          <>
            <dt>配布元</dt><dd>{p.source_url ? <a href={p.source_url}>{p.source_name}</a> : p.source_name}</dd>
            <dt>条件</dt><dd class="pre">{p.license}</dd>
            <dt>大きさ</dt><dd>{formatSize(p.size)}（版 {p.version}・{formatDate(p.updated_at)}）</dd>
          </>
        )}
        <dt>既定</dt><dd>{p.is_default ? 'すべてのシナリオで使う' : 'シナリオの投稿者が選んだシナリオだけで使う'}</dd>
      </dl>
      {p.kind === 'community' && (
        <>
          <h2>投稿（{props.submissions.length} 件）</h2>
          {props.submissions.length === 0 ? <p class="muted">まだありません。</p> : (
            <ul class="scenario-list">
              {props.submissions.map(s => (
                <li>
                  <span class="title">{s.title}</span>
                  <div class="meta">{s.author ?? s.handle} ・ {s.files} ファイル ・ {formatDate(s.reviewed_at ?? s.created_at)}</div>
                  {s.license && <p class="summary pre">{s.license}</p>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <h2>取り下げた記録</h2>
      {props.takedowns.length === 0 ? <p class="muted">ありません。</p> : (
        <ul>{props.takedowns.map(t => <li>{formatDate(t.created_at)} {t.target_id}: {t.reason}</li>)}</ul>
      )}
    </section>
  );
}

export type PackForm = { id: string; title: string; description: string; policy: string; accepts: string };

export function PackFields(props: { v: PackForm; isNew: boolean }) {
  const v = props.v;
  return (
    <>
      {props.isNew && (
        <label>ID（URL とシナリオのカタログに使う。英小文字・数字・-、3〜40 文字。後から変えられません）
          <input name="id" value={v.id} pattern="[a-z0-9][a-z0-9\-]{1,38}[a-z0-9]" required />
        </label>
      )}
      <label>名前<input name="title" value={v.title} maxlength={100} required /></label>
      <label>説明（どんな素材を集めるか）<textarea name="description" rows={4} maxlength={5000}>{v.description}</textarea></label>
      {props.isNew ? (
        <fieldset class="pack-choice">
          <legend>管理ポリシー（後から変えられません）</legend>
          {Object.values(POLICIES).map(p => (
            <label class="check">
              <input type="radio" name="policy" value={p.id} checked={v.policy === p.id} required />
              <span><strong>{p.title}</strong><br /><span class="small">{p.license}</span></span>
            </label>
          ))}
        </fieldset>
      ) : <p>管理ポリシー: {policyOf(v.policy)?.title ?? v.policy}</p>}
      <label>投稿
        <select name="accepts">
          <option value="anyone" selected={v.accepts === 'anyone'}>だれでも投稿でき、管理者が承認する</option>
          <option value="managers" selected={v.accepts === 'managers'}>管理者だけが投稿する</option>
        </select>
      </label>
    </>
  );
}

export function NewPackPage(props: { v: PackForm; error?: string }) {
  return (
    <section>
      <h1>パックを作る</h1>
      <p>画像・効果音・BGM・データなどの素材を集める共有パックを作ります。作った人がパックの管理者になり、投稿を承認します。承認した素材は、管理者のブラウザで 1 つの zip にまとめて配ります。</p>
      {props.error && <Notice kind="error">{props.error}</Notice>}
      <form method="post" action="/my/packs/new" class="form">
        <PackFields v={props.v} isNew={true} />
        <button type="submit">作る</button>
      </form>
    </section>
  );
}

export type ReviewItem = { id: number; title: string; handle: string; state: string; files: number; size: number; created_at: number };

export function ManagePackPage(props: {
  p: PackDetail; v: PackForm; pending: ReviewItem[]; approved: ReviewItem[]; managers: { handle: string; role: string }[];
  files: number; error?: string; saved?: boolean; build: boolean; directUpload: boolean;
}) {
  const p = props.p;
  const dirty = p.revision !== p.built_revision;
  return (
    <>
      <section>
        <h1>{p.title} の管理</h1>
        <p><a href={`/packs/${p.id}`}>パックの頁へ</a></p>
        {props.error && <Notice kind="error">{props.error}</Notice>}
        {props.saved && <Notice>保存しました。</Notice>}
      </section>
      <section>
        <h2>承認待ち（{props.pending.length} 件）</h2>
        {props.pending.length === 0 ? <p class="muted">ありません。</p> : (
          <ul class="scenario-list">
            {props.pending.map(s => (
              <li>
                <a class="title" href={`/my/submissions/${s.id}`}>{s.title}</a>
                <div class="meta">{s.handle} ・ {s.files} ファイル ・ {formatSize(s.size)} ・ {formatDate(s.created_at)} ・ <a href={`/my/submissions/${s.id}`}>中身を見て承認・却下する</a></div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h2>zip への反映</h2>
        <p>承認した素材（{props.files} ファイル）を、このブラウザで 1 つの zip にまとめて上げます。投稿の zip から圧縮したままの中身を写すので、展開はしません。上げた zip はサイトが目次を確かめてから配ります。</p>
        {dirty ? <Notice>承認・取り外しの後、まだ zip に反映していません。</Notice> : <p class="muted">反映済みです。</p>}
        <form id="pack-build" class="form" data-pack={p.id} data-autostart={props.build && dirty ? '1' : '0'}>
          <button type="submit" disabled={props.files === 0}>zip に反映する</button>
          <progress hidden max={100} value={0}></progress>
          <p class="status" aria-live="polite"></p>
        </form>
        <script src="/static/uploader.js" defer></script>
        <script src="/static/pack-build.js" defer></script>
      </section>
      <section>
        <h2>承認した投稿</h2>
        {props.approved.length === 0 ? <p class="muted">ありません。</p> : (
          <ul class="scenario-list">
            {props.approved.map(s => (
              <li>
                <a class="title" href={`/my/submissions/${s.id}`}>{s.title}</a>
                <div class="meta">{s.handle} ・ パックに入っているファイル {s.files} ・ {formatDate(s.created_at)}</div>
                <form method="post" action={`/my/submissions/${s.id}/remove`} class="inline" onsubmit="return confirm('この投稿のファイルをパックから外しますか？')">
                  <button type="submit" class="link">この投稿のファイルを外す</button>
                </form>
              </li>
            ))}
          </ul>
        )}
        <form method="post" action={`/my/packs/${p.id}/files/remove`} class="compact">
          <label>パックの中の道でファイルを外す<input name="path" placeholder="Bitmap/Pilot/xxx.bmp" required /></label>
          <button type="submit">外す</button>
        </form>
      </section>
      <section>
        <h2>管理者</h2>
        <ul>{props.managers.map(m => <li><a href={`/users/${m.handle}`}>{m.handle}</a>{m.role === 'owner' && '（作成者）'}</li>)}</ul>
        <p class="muted small">運営もすべてのパックを管理できます。</p>
      </section>
      <section>
        <h2>パックの情報</h2>
        <form method="post" action={`/my/packs/${p.id}`} class="form">
          <PackFields v={props.v} isNew={false} />
          <button type="submit">保存</button>
        </form>
      </section>
    </>
  );
}

export function SubmitPage(props: { p: PackDetail; turnstileKey?: string; directUpload: boolean }) {
  const p = props.p;
  const policy = policyOf(p.policy);
  return (
    <section>
      <h1>{p.title} に投稿する</h1>
      <p>素材を SRC のフォルダの形（<code>Bitmap/Pilot/…</code>・<code>Sound/…</code>・<code>Midi/…</code>・<code>Data/…</code>）にして zip にしたものを選んでください（1 GB まで）。フォルダごと zip にしてもかまいません。パックの管理者が中身を見て承認すると、パックに入ります。</p>
      <ul class="small">
        <li><strong>JASRAC の管理曲は投稿できません。</strong>ほかの人の作品は、配布の条件が認めている場合だけ投稿してください（<a href="/about/terms">利用規約</a>）</li>
        <li>パックにすでに同じ名前（大文字小文字を区別しない）のファイルがあれば、承認されたときにこの投稿のものに差し替わります</li>
      </ul>
      <form id="upload" class="form" data-kind="resource" data-create-url={`/api/packs/${p.id}/submissions`} data-fields="title,author,license,agree" data-direct={props.directUpload ? '1' : '0'}>
        <label>題名<input name="title" maxlength={100} required /></label>
        <label>作者（投稿者と違う場合。空なら表示名）<input name="author" maxlength={100} /></label>
        <label>ライセンス・配布の条件（出典、パックの管理ポリシーに加える条件）{policy?.requiresLicense && '（必須）'}<textarea name="license" rows={4} maxlength={5000} required={policy?.requiresLicense}></textarea></label>
        <label class="check"><input type="checkbox" name="agree" required /> {policy?.agreement ?? p.license}</label>
        <input type="file" name="file" accept=".zip,application/zip" required />
        <Turnstile siteKey={props.turnstileKey} />
        <button type="submit">上げる</button>
        <progress hidden max={100} value={0}></progress>
        <p class="status" aria-live="polite"></p>
      </form>
      <script src="/static/uploader.js" defer></script>
      <script src="/static/upload.js" defer></script>
    </section>
  );
}

export type SubmissionFile = { path: string; size: number; state: string; conflict: number };

const MEDIA_LABELS: Record<MediaKind, string> = {
  image: '画像', audio: '音', midi: 'MIDI', data: 'データ', event: 'イベント', map: 'マップ', document: '文書', other: 'ほか',
};

export function SubmissionPage(props: {
  s: {
    id: number; pack_id: string; title: string; author: string | null; license: string | null; state: string; size: number; created_at: number;
    inspect_note: string | null; review_note: string | null; handle: string; reviewer: string | null; reviewed_at: number | null;
  };
  p: { id: string; title: string; policy: string | null };
  files: SubmissionFile[];
  canReview: boolean;
  isSubmitter: boolean;
  /** パックの zip に、承認したものがすべて入っているか */
  reflected: boolean;
}) {
  const { s, p } = props;
  const preview = s.state === 'pending' || s.state === 'approved';
  const url = (path: string) => `/files/pack-submissions/${s.id}/${path.split('/').map(encodeURIComponent).join('/')}`;
  const images = props.files.filter(f => mediaKind(f.path) === 'image');
  const sounds = props.files.filter(f => mediaKind(f.path) === 'audio');
  const conflicts = props.files.filter(f => f.conflict);
  const counts = new Map<MediaKind, number>();
  for (const f of props.files) {
    counts.set(mediaKind(f.path), (counts.get(mediaKind(f.path)) ?? 0) + 1);
  }
  return (
    <>
      <section>
        <h1>{s.title}</h1>
        <p class="meta">
          <a href={`/packs/${p.id}`}>{p.title}</a> への投稿 ・ {s.author && s.author !== s.handle && <>作者: {s.author} ・ </>}投稿: <a href={`/users/${s.handle}`}>{s.handle}</a> ・ {formatDate(s.created_at)} ・ {formatSize(s.size)}
          {' '}<span class={`badge${s.state === 'rejected' ? ' stopped' : ''}`}>{SUBMISSION_STATES[s.state] ?? s.state}</span>
        </p>
        <SubmissionStatus s={s} reflected={props.reflected} />
        {s.license && <p class="pre">{s.license}</p>}
        {props.canReview && s.state === 'pending' && (
          <div class="actions">
            <form method="post" action={`/my/submissions/${s.id}/approve`} class="inline">
              <button type="submit" class="primary">承認して zip に反映する</button>
            </form>
            <form method="post" action={`/my/submissions/${s.id}/reject`} class="inline">
              <input name="note" placeholder="却下の理由（投稿者に見えます）" maxlength={500} /> <button type="submit" class="danger">却下する</button>
            </form>
          </div>
        )}
        {preview && (
          <p><a href={`/viewer/archive?index=${encodeURIComponent(`/api/viewer/submissions/${s.id}/index.json`)}&id=submission-${s.id}`}>データビューアで見る・聞く</a>（データ・MIDI も。パックの画像と重ねて見られます）</p>
        )}
        {props.isSubmitter && s.state === 'pending' && (
          <form method="post" action={`/my/submissions/${s.id}/withdraw`} onsubmit="return confirm('この投稿を取り下げますか？')">
            <button type="submit" class="link">投稿を取り下げる</button>
          </form>
        )}
      </section>
      {props.files.length > 0 && (
        <section>
          <h2>中身（{props.files.length} ファイル）</h2>
          <p>{[...counts].map(([k, n]) => `${MEDIA_LABELS[k]} ${n}`).join('・')}</p>
          {conflicts.length > 0 && (
            <Notice>パックにすでにある {conflicts.length} ファイルを差し替えます: {conflicts.slice(0, 20).map(f => f.path).join('、')}{conflicts.length > 20 && ' ほか'}</Notice>
          )}
        </section>
      )}
      {preview && images.length > 0 && (
        <section>
          <h2>画像（{images.length}）</h2>
          <div class="image-grid">
            {images.slice(0, 500).map(f => (
              <figure>
                <a href={url(f.path)} target="_blank" rel="noopener"><img src={url(f.path)} loading="lazy" alt={f.path} /></a>
                <figcaption class="small">{f.path}{f.conflict ? ' （差し替え）' : ''}</figcaption>
              </figure>
            ))}
          </div>
          {images.length > 500 && <p class="muted">ほか {images.length - 500} 個。</p>}
        </section>
      )}
      {preview && sounds.length > 0 && (
        <section>
          <h2>音（{sounds.length}）</h2>
          <ul class="sound-list">
            {sounds.slice(0, 300).map(f => <li><span class="small">{f.path}</span> <audio controls preload="none" src={url(f.path)}></audio></li>)}
          </ul>
        </section>
      )}
      {props.files.length > 0 && (
        <section>
          <h2>ファイル</h2>
          <table class="files">
            <tbody>
              {props.files.slice(0, 2000).map(f => (
                <tr>
                  <td>{preview ? <a href={url(f.path)} target="_blank" rel="noopener">{f.path}</a> : f.path}</td>
                  <td class="num">{f.size.toLocaleString()}</td>
                  <td>{f.state === 'active' ? 'パックに入っている' : f.state === 'replaced' ? '差し替えられた' : f.state === 'removed' ? '外した' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {props.files.length > 2000 && <p class="muted">ほか {props.files.length - 2000} ファイル。</p>}
        </section>
      )}
    </>
  );
}

/** 投稿の状態（投稿した人に、承認・却下・zip への反映を知らせる） */
export function SubmissionStatus(props: {
  s: { state: string; inspect_note: string | null; review_note: string | null; reviewer: string | null; reviewed_at: number | null };
  reflected: boolean;
}) {
  const { s } = props;
  const by = s.reviewed_at ? <>（{formatDate(s.reviewed_at)}{s.reviewer && <>・{s.reviewer}</>}）</> : null;
  switch (s.state) {
    case 'uploading':
    case 'inspecting':
      return <Notice>検査しています。しばらくしてから頁を読み込み直してください。</Notice>;
    case 'pending':
      return <Notice>検査に通りました。パックの管理者の承認を待っています。</Notice>;
    case 'approved':
      return <Notice>承認されました{by}。{props.reflected ? 'パックの zip に入っています。' : 'パックの zip にはまだ入っていません（管理者が反映すると入ります）。'}</Notice>;
    case 'retired':
      return <Notice>承認されましたが{by}、ファイルはすべてほかの投稿に差し替わったか、外されました。</Notice>;
    case 'withdrawn':
      return <Notice>取り下げました{by}。</Notice>;
    case 'rejected':
      return s.inspect_note
        ? <Notice kind="error">検査で弾かれました: {s.inspect_note}</Notice>
        : <Notice kind="error">却下されました{by}。{s.review_note && <>理由: {s.review_note}</>}</Notice>;
    default:
      return null;
  }
}

export function isPolicyId(id: string): id is PolicyId {
  return id in POLICIES;
}
