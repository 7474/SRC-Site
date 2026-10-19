// 通報を GitHub の Issue にする（docs/operations.md の「通報」）
// REPORT_REPO（owner/repo）と GITHUB_TOKEN（その repo の Issues: Read and write）があるときだけ
// 公開の repo には詳細と連絡先を書かない（通報者の個人の情報が載りうるため）。運営の画面で見る
import type { Bindings } from '../env';

const API = 'https://api.github.com';

export const REPORT_REASONS: Record<string, string> = {
  rights: '権利の侵害',
  adult: '成人向けの内容',
  malware: '有害なファイル',
  other: 'その他',
};

export type ReportIssue = {
  site: string;
  origin: string;
  slug: string;
  title: string;
  reason: string;
  detail: string;
  contact: string | null;
};

function headers(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'src-site',
  };
}

/** Issue の題と本文。公開の repo なら詳細と連絡先を書かない */
export function issueContent(r: ReportIssue, isPrivate: boolean): { title: string; body: string } {
  const reason = REPORT_REASONS[r.reason] ?? r.reason;
  const lines = [
    `- シナリオ: [${r.title}](${r.origin}/scenarios/${r.slug})（\`${r.slug}\`）`,
    `- 理由: ${reason}`,
  ];
  if (isPrivate) {
    lines.push('', '### 詳細', '', r.detail ? r.detail.split('\n').map(l => `> ${l}`).join('\n') : '（なし）', '', `- 連絡先: ${r.contact ?? '（なし）'}`);
  } else {
    lines.push('', '詳細と連絡先は運営の画面で見てください（公開の repo には載せません）。');
  }
  lines.push('', `運営の画面: ${r.origin}/admin`);
  return { title: `[通報][${r.site}] ${reason}: ${r.title}`, body: lines.join('\n') };
}

/** Issue を作り、その URL を返す。設定が無い・失敗したときは null（通報は D1 に残っている） */
export async function createReportIssue(env: Bindings, r: ReportIssue): Promise<string | null> {
  if (!env.REPORT_REPO || !env.GITHUB_TOKEN) {
    return null;
  }
  try {
    const repo = await fetch(`${API}/repos/${env.REPORT_REPO}`, { headers: headers(env.GITHUB_TOKEN) });
    if (!repo.ok) {
      console.error('GitHub の repo を読めません', repo.status);
      return null;
    }
    const { private: isPrivate } = await repo.json<{ private: boolean }>();
    const res = await fetch(`${API}/repos/${env.REPORT_REPO}/issues`, {
      method: 'POST',
      headers: { ...headers(env.GITHUB_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify(issueContent(r, isPrivate)),
    });
    if (!res.ok) {
      console.error('GitHub の Issue を作れません', res.status, await res.text());
      return null;
    }
    return (await res.json<{ html_url: string }>()).html_url;
  } catch (e) {
    console.error('GitHub の Issue を作れません', e);
    return null;
  }
}
