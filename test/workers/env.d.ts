// cloudflare:workers の env・exports の型（wrangler.jsonc のバインディングとテストだけのバインディング、Worker の既定の export）
import type { D1Migration } from 'cloudflare:test';
import type { Bindings } from '../../src/env';

declare global {
  namespace Cloudflare {
    interface Env extends Bindings {
      TEST_MIGRATIONS: D1Migration[];
    }
    interface GlobalProps {
      mainModule: typeof import('../../src/index');
    }
  }
}
