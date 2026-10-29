import { formatDate, formatSize } from '../lib/util';

export type HiddenItem = { slug: string; title: string; hidden_reason: string | null };
export type UserItem = { id: number; handle: string; role: string; suspended: number; created_at: number };

export type PendingPackSubmission = {
  id: number; slug: string; title: string; source_name: string; license: string; size: number; created_at: number; submitted_by: string;
};

export function AdminPage(props: { users: UserItem[]; hidden: HiddenItem[]; packSubmissions: PendingPackSubmission[]; message?: string }) {
  return (
    <>
      <section>
        <h1>運営</h1>
        {props.message && <p class="notice info">{props.message}</p>}
        <p class="small">通報は Google フォームに届きます。シナリオの公開を止めるときは、シナリオの頁の「運営: 公開を止める」を使います。</p>
      </section>
      <section>
        <h2>公開を止めているシナリオ</h2>
        {props.hidden.length === 0 ? <p class="muted">ありません。</p> : (
          <ul>
            {props.hidden.map(h => (
              <li>
                <a href={`/scenarios/${h.slug}`}>{h.title}</a>（{h.slug}）{h.hidden_reason && `: ${h.hidden_reason}`}
                <form method="post" action={`/admin/scenarios/${h.slug}/unhide`} class="inline"><button type="submit" class="link">再開する</button></form>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h2>パックのファイルの取り下げ</h2>
        <p class="small">記録だけを残す。zip から除くのは packs ワークフローを流し直したとき（packs/README.md）。パック全体を止めるときはパスを空にする。</p>
        <form method="post" action="/admin/takedowns" class="compact">
          <input name="pack" placeholder="パックの ID" required />
          <input name="path" placeholder="パス（空ならパック全体）" />
          <input name="reason" placeholder="理由" required />
          <input name="requested_by" placeholder="申し出た人" />
          <button type="submit">取り下げる</button>
        </form>
      </section>
      <section>
        <h2>共有パックの確認待ち</h2>
        {props.packSubmissions.length === 0 ? <p class="muted">ありません。</p> : (
          <ul>
            {props.packSubmissions.map(p => (
              <li>
                <a href={`/admin/pack-submissions/${p.id}`}>{p.title}</a>（{p.slug}）— 投稿者 {p.submitted_by}・{p.source_name}・{formatSize(p.size)}・{formatDate(p.created_at)}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h2>利用者</h2>
        <table>
          <thead><tr><th>表示名</th><th>権限</th><th>登録</th><th></th></tr></thead>
          <tbody>
            {props.users.map(u => (
              <tr>
                <td><a href={`/users/${u.handle}`}>{u.handle}</a></td>
                <td>{u.role}{u.suspended ? '（停止）' : ''}</td>
                <td>{formatDate(u.created_at)}</td>
                <td>
                  {u.role !== 'admin' && (
                    <form method="post" action={`/admin/users/${u.id}/${u.suspended ? 'unsuspend' : 'suspend'}`}>
                      <button type="submit" class="link">{u.suspended ? '停止を解く' : '停止する'}</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

export function PackReviewPage(props: {
  submission: PendingPackSubmission & {
    description: string | null; source_url: string | null; root: string | null; excludes_jasrac: number;
    status: string; review_note: string | null;
  };
}) {
  const p = props.submission;
  return (
    <>
      <section>
        <h1>共有パックの確認</h1>
        <p><a href="/admin">運営へ戻る</a></p>
        <p class="badge">{p.status === 'pending' ? '確認待ち' : p.status}</p>
        {p.review_note && <p class="notice info">{p.review_note}</p>}
      </section>
      <section>
        <h2>{p.title}（{p.slug}）</h2>
        {p.description && <p class="pre">{p.description}</p>}
        <dl>
          <dt>投稿者・出典</dt><dd>{p.source_url ? <a href={p.source_url} rel="noreferrer">{p.source_name}</a> : p.source_name}</dd>
          <dt>投稿者アカウント</dt><dd>{p.submitted_by}</dd>
          <dt>再配布の条件</dt><dd class="pre">{p.license}</dd>
          <dt>zip</dt><dd>{formatSize(p.size)}{p.root && `・フォルダ ${p.root}`}</dd>
          <dt>JASRAC 管理楽曲</dt><dd>{p.excludes_jasrac ? '含まないとの申告あり（内容を確認してください）' : '申告なし'}</dd>
          <dt>申請日</dt><dd>{formatDate(p.created_at)}</dd>
        </dl>
        {p.status === 'pending' && (
          <>
            <p><a class="button" href={`/admin/pack-submissions/${p.id}/archive`}>非公開 zip をダウンロードして確認</a></p>
            <p class="small">出典・再配布条件・zip の内容を確認し、JASRAC 管理楽曲が含まれていないことを確認してから承認してください。</p>
            <form method="post" action={`/admin/pack-submissions/${p.id}/approve`} class="inline" onsubmit="return confirm('このパックを公開しますか？')">
              <button type="submit">確認して公開</button>
            </form>
            <form method="post" action={`/admin/pack-submissions/${p.id}/reject`} class="form">
              <label>差し戻す理由<textarea name="note" rows={3} maxlength={500} required /></label>
              <button type="submit" class="danger">差し戻す</button>
            </form>
          </>
        )}
      </section>
    </>
  );
}
