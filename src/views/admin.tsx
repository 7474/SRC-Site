import { formatDate } from '../lib/util';

export type ReportItem = { id: number; reason: string; detail: string | null; contact: string | null; created_at: number; slug: string | null; title: string | null; pack_id: string | null; hidden: number | null };
export type HiddenItem = { slug: string; title: string; hidden_reason: string | null };
export type UserItem = { id: number; handle: string; role: string; suspended: number; created_at: number };

export function AdminPage(props: { reports: ReportItem[]; users: UserItem[]; hidden: HiddenItem[]; message?: string }) {
  return (
    <>
      <section>
        <h1>運営</h1>
        {props.message && <p class="notice info">{props.message}</p>}
        <h2>未対応の通報</h2>
        {props.reports.length === 0 ? <p class="muted">ありません。</p> : (
          <table>
            <thead><tr><th>日時</th><th>対象</th><th>理由</th><th>詳細・連絡先</th><th>対応</th></tr></thead>
            <tbody>
              {props.reports.map(r => (
                <tr>
                  <td>{formatDate(r.created_at)}</td>
                  <td>{r.slug ? <a href={`/scenarios/${r.slug}`}>{r.title}</a> : r.pack_id ? <a href={`/packs/${r.pack_id}`}>{r.pack_id}</a> : '（削除済み）'}</td>
                  <td>{r.reason}</td>
                  <td class="pre">{r.detail}{r.contact && `\n連絡先: ${r.contact}`}</td>
                  <td>
                    {r.slug && (
                      <form method="post" action={`/admin/scenarios/${r.slug}/hide`} class="compact">
                        <input name="reason" placeholder="止める理由（公開されます）" />
                        <button type="submit">{r.hidden ? '止めている' : '公開を止める'}</button>
                      </form>
                    )}
                    <form method="post" action={`/admin/reports/${r.id}/close`}><button type="submit" class="link">対応済みにする</button></form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
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
