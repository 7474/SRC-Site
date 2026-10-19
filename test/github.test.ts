import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReportIssue, issueContent, type ReportIssue } from '../src/lib/github';
import type { Bindings } from '../src/env';

const report: ReportIssue = {
  site: 'SRC-Site', origin: 'https://src.koudenpa.net', slug: 'lantern', title: 'ランタン号',
  reason: 'rights', detail: '私の素材です\n2 行目', contact: 'a@example.com',
};

describe('issueContent', () => {
  it('公開の repo には詳細と連絡先を書かない', () => {
    const { title, body } = issueContent(report, false);
    expect(title).toBe('[通報][SRC-Site] 権利の侵害: ランタン号');
    expect(body).toContain('https://src.koudenpa.net/scenarios/lantern');
    expect(body).toContain('https://src.koudenpa.net/admin');
    expect(body).not.toContain('私の素材です');
    expect(body).not.toContain('a@example.com');
  });

  it('非公開の repo には詳細と連絡先を書く', () => {
    const { body } = issueContent(report, true);
    expect(body).toContain('> 私の素材です\n> 2 行目');
    expect(body).toContain('a@example.com');
  });
});

describe('createReportIssue', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('設定が無ければ何もしない', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await createReportIssue({} as Bindings, report)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('repo の公開・非公開を見て Issue を作る', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ private: true }))
      .mockResolvedValueOnce(Response.json({ html_url: 'https://github.com/o/r/issues/1' }, { status: 201 }));
    vi.stubGlobal('fetch', fetch);
    const env = { REPORT_REPO: 'o/r', GITHUB_TOKEN: 't' } as Bindings;
    expect(await createReportIssue(env, report)).toBe('https://github.com/o/r/issues/1');
    expect(fetch.mock.calls[1][0]).toBe('https://api.github.com/repos/o/r/issues');
    expect(JSON.parse(fetch.mock.calls[1][1].body).body).toContain('a@example.com');
  });

  it('失敗しても例外にしない', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no', { status: 404 })));
    expect(await createReportIssue({ REPORT_REPO: 'o/r', GITHUB_TOKEN: 't' } as Bindings, report)).toBeNull();
  });
});
