import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env';

export type ScenarioRow = {
  id: number; slug: string; owner_id: number; title: string; author: string | null; description: string | null; license: string | null;
  tags: string; visibility: string; hidden: number; hidden_reason: string | null; latest_version: number | null;
  created_at: number; updated_at: number; handle: string;
  /** 'scenario' | 'resource'（共有パックに投稿した素材） */
  kind: string; pack_id: string | null;
};

export async function getScenario(c: Context<AppEnv>, slug: string): Promise<ScenarioRow | null> {
  return c.env.DB.prepare('SELECT s.*, u.handle FROM scenarios s JOIN users u ON u.id = s.owner_id WHERE s.slug = ?')
    .bind(slug).first<ScenarioRow>();
}

/** 見せてよいか（運営が止めたもの・非公開は、投稿者と運営にだけ見せる） */
export function canView(c: Context<AppEnv>, s: ScenarioRow): boolean {
  const user = c.get('user');
  if (user && (user.id === s.owner_id || user.role === 'admin')) {
    return true;
  }
  return !s.hidden && s.visibility !== 'private';
}

export function canEdit(c: Context<AppEnv>, s: ScenarioRow): boolean {
  const user = c.get('user');
  return Boolean(user && !user.suspended && (user.id === s.owner_id || user.role === 'admin'));
}

// createMiddleware で作り、後ろのハンドラのパスのパラメータの型を保つ
export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get('user');
  if (!user) {
    if (c.req.path.startsWith('/api/')) {
      return c.json({ error: 'ログインしてください' }, 401);
    }
    return c.redirect(`/auth/login?next=${encodeURIComponent(c.req.path)}`);
  }
  if (user.suspended) {
    return c.text('アカウントが停止されています。', 403);
  }
  await next();
});

export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get('user');
  if (!user || user.role !== 'admin') {
    return c.notFound();
  }
  await next();
});

export const LIST_SELECT = `
  SELECT s.slug, s.kind, s.title, s.author, s.description, s.updated_at, s.visibility, s.hidden, u.handle, v.size,
         (SELECT SUM(plays + downloads) FROM counters c WHERE c.scenario_id = s.id AND c.day >= date('now', '-7 day')) AS plays
    FROM scenarios s JOIN users u ON u.id = s.owner_id LEFT JOIN versions v ON v.id = s.latest_version`;
