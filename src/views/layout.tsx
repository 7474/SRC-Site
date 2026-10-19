import type { Child } from 'hono/jsx';
import type { User } from '../env';
import { RATING_LABELS, type Rating } from '../lib/util';

export function Layout(props: { title: string; siteName: string; user: User | null; children: Child; head?: Child }) {
  const { title, siteName, user } = props;
  return (
    <html lang="ja">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title === siteName ? siteName : `${title} - ${siteName}`}</title>
        <link rel="stylesheet" href="/static/site.css" />
        {props.head}
      </head>
      <body>
        <header class="site-header">
          <a class="site-name" href="/">{siteName}</a>
          <form class="search" action="/" method="get">
            <input type="search" name="q" placeholder="シナリオを探す" aria-label="シナリオを探す" />
          </form>
          <nav>
            <a href="/play/">Web 版</a>
            {user ? (
              <>
                <a href="/s/submit">投稿</a>
                <a href="/me">{user.handle}</a>
                {user.role === 'admin' && <a href="/admin">運営</a>}
              </>
            ) : (
              <a href="/auth/login">ログイン</a>
            )}
          </nav>
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

export function RatingBadge(props: { rating: string }) {
  if (props.rating === 'general') {
    return null;
  }
  return <span class={`badge rating-${props.rating}`}>{RATING_LABELS[props.rating as Rating] ?? props.rating}</span>;
}

export function Notice(props: { kind?: 'error' | 'info'; children: Child }) {
  return <p class={`notice ${props.kind ?? 'info'}`}>{props.children}</p>;
}
