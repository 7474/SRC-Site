import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// 2 つのプロジェクトに分ける（docs/development.md の「テスト」）
// - node: ライブラリ（zip・カタログ・検査など）を Node で確かめる
// - workers: Worker を Workers の実行環境（Miniflare）で動かし、D1・R2 を使って経路（認証・権限・投稿・承認・上限）を確かめる
//   https://developers.cloudflare.com/workers/testing/vitest-integration/
export default defineConfig({
  test: {
    projects: [
      {
        test: { name: 'node', include: ['test/**/*.test.ts'], exclude: ['test/workers/**'] },
      },
      {
        plugins: [
          cloudflareTest(async () => ({
            // 既定（--env なし）のローカル開発用の設定を使う
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: {
              // D1 のマイグレーションは setup.ts で当てる
              bindings: { TEST_MIGRATIONS: await readD1Migrations('./migrations') },
              // 回数の制限は経路の確かめの邪魔になるので緩める（制限そのものは確かめない）
              ratelimits: {
                API_LIMITER: { namespace_id: '7401', simple: { limit: 100000, period: 60 } },
                WRITE_LIMITER: { namespace_id: '7402', simple: { limit: 100000, period: 60 } },
              },
            },
          })),
        ],
        test: { name: 'workers', include: ['test/workers/**/*.test.ts'], setupFiles: ['test/workers/setup.ts'] },
      },
    ],
  },
});
