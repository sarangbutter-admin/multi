// Netlify entry point: every /api/* request goes to the multi-tenant app.
// With DEMO_MODE=1 (and no database), the site runs on sample stores kept in memory: good for a preview link,
// but data resets whenever Netlify starts a fresh copy of the function, and two copies don't share data.
import { makeApp } from '../../lib/app.mjs';
import { supabaseDb } from '../../lib/db-supabase.mjs';

let ready;
async function start() {
  if (process.env.DEMO_MODE === '1') {
    const [{ memoryDb }, { seedDemo, DEMO_ENV }] = await Promise.all([import('../../lib/db-memory.mjs'), import('../../lib/demo.mjs')]);
    const db = memoryDb(); await seedDemo(db);
    return makeApp({ db, env: { ...DEMO_ENV, ...process.env } });
  }
  return makeApp({ db: supabaseDb({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY }), env: process.env });
}
export default async req => {
  ready ||= start().catch(e => { ready = null; throw e; });
  return (await ready).handle(req);
};
export const config = { path: '/api/*' };
