import type { Child } from 'hono/jsx';
import type { User } from '../env';

export function Layout(props: { title: string; siteName: string; user: User | null; children: Child; head?: Child }) {
  const { title, siteName, user } = props;
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
          <a class="site-name" href="/">{siteName}</a>
          <form class="search" action="/" method="get" role="search">
            <input type="search" name="q" placeholder="シナリオを探す" aria-label="シナリオを探す" />
          </form>
          <nav>
            <a href="/play/">SRC#Web で遊ぶ</a>
            <a href="/viewer/">データビューア</a>
            {user ? (
              <>
                <a href="/my/scenarios/new">投稿</a>
                <a href="/my">{user.handle}</a>
                {user.role === 'admin' && <a href="/admin">運営</a>}
              </>
            ) : (
              <a href="/auth/login">ログイン</a>
            )}
          </nav>
          </div>
        </header>
        <main>{props.children}</main>
        <footer class="site-footer">
          <a href="/about/terms">利用規約</a>
          <a href="/about/rights">権利者の方へ</a>
          <a href="/packs">共有パック</a>
          <a href="https://github.com/7474/SRC-Site">ソース</a>
        </footer>
      </body>
    </html>
  );
}


export function Notice(props: { kind?: 'error' | 'info'; children: Child }) {
  return <p class={`notice ${props.kind ?? 'info'}`}>{props.children}</p>;
}
