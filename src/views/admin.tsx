import { formatDate } from '../lib/util';

export type HiddenItem = { slug: string; title: string; hidden_reason: string | null };
export type UserItem = { id: number; handle: string; role: string; suspended: number; created_at: number };

export function AdminPage(props: { users: UserItem[]; hidden: HiddenItem[]; message?: string }) {
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
