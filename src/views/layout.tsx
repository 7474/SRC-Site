import type { Child } from 'hono/jsx';
import type { User } from '../env';

/** path: 今の頁の道（ヘッダ・フッターで今いる所を示す） */
export function Layout(props: { title: string; siteName: string; user: User | null; path?: string; children: Child; head?: Child }) {
  const { title, siteName, user } = props;
  const path = props.path ?? '';
  return (
    <html lang="ja">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title === siteName ? siteName : `${title} - ${siteName}`}</title>
        <link rel="stylesheet" href="/static/site.css" />
        <link rel="icon" href="/static/favicon.ico" sizes="16x16 32x32 48x48 64x64" />
        <link rel="icon" type="image/png" href="/static/icon.png" sizes="128x128" />
        <link rel="apple-touch-icon" href="/static/apple-touch-icon.png" />
        {props.head}
      </head>
      <body>
        <header class="site-header">
          <div class="site-header-inner">
          <a class="site-name" href="/" aria-current={path === '/' ? 'page' : undefined}>{siteName}</a>
          <form class="search" action="/" method="get" role="search">
            <input type="search" name="q" placeholder="シナリオを探す" aria-label="シナリオを探す" />
          </form>
          {/* どの幅でも 1 行に収まるよう、ヘッダは「遊ぶ」とアカウントだけにする。ほかはアカウントのメニュー・フッター・トップ頁から */}
          <nav class="site-nav" aria-label="サイト">
            <a href="/play/">遊ぶ</a>
            {user ? (
              <details class="account">
                {/* 押すとメニューが開くことが分かるよう、人の印と ▼ を付けたボタンの形にする */}
                <summary aria-current={/^\/(my|admin)(\/|$)/.test(path) ? 'page' : undefined}>
                  <svg class="icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="2" /><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
                  <span class="handle">{user.handle}</span>
                  <span class="visually-hidden">のメニュー</span>
                  <svg class="chevron" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
                </summary>
                <div class="menu">
                  <a href="/my" aria-current={path === '/my' ? 'page' : undefined}>マイページ</a>
                  <a href="/my/scenarios/new" aria-current={path === '/my/scenarios/new' ? 'page' : undefined}>シナリオを投稿</a>
                  <a href="/my/packs" aria-current={path === '/my/packs' ? 'page' : undefined}>共有パックを投稿</a>
                  {user.role === 'admin' && <a href="/admin" aria-current={path.startsWith('/admin') ? 'page' : undefined}>運営</a>}
                  <form method="post" action="/auth/logout"><button type="submit">ログアウト</button></form>
                </div>
              </details>
            ) : (
              <a href={`/auth/login?next=${encodeURIComponent(path)}`}>ログイン</a>
            )}
          </nav>
          </div>
        </header>
        <main>{props.children}</main>
        <footer class="site-footer">
          <nav aria-label="道具と素材">
            <span class="footer-label">道具と素材</span>
            <a href="/check" aria-current={path === '/check' ? 'page' : undefined}>チェッカー</a>
            <a href="/viewer/">データビューア</a>
            <a href="/packs" aria-current={path.startsWith('/packs') ? 'page' : undefined}>共有パック</a>
          </nav>
          <nav aria-label="サイトについて">
            <span class="footer-label">サイトについて</span>
            <a href="/about/terms" aria-current={path === '/about/terms' ? 'page' : undefined}>利用規約</a>
            <a href="/about/rights" aria-current={path === '/about/rights' ? 'page' : undefined}>権利者の方へ</a>
            <a href="https://github.com/7474/SRC-Site">ソース</a>
          </nav>
        </footer>
        <script src="/static/nav.js" defer></script>
      </body>
    </html>
  );
}


export function Notice(props: { kind?: 'error' | 'info'; children: Child }) {
  return <p class={`notice ${props.kind ?? 'info'}`}>{props.children}</p>;
}
