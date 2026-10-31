// workers のテストの前に D1 にマイグレーションを当てる（vitest.config.ts の TEST_MIGRATIONS）。
// 当てたものは d1_migrations に記録され、二度は当てない
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
