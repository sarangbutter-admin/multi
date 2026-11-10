// Netlify entry point: every /api/* request goes to the multi-tenant app.
import { makeApp } from '../../lib/app.mjs';
import { supabaseDb } from '../../lib/db-supabase.mjs';

let app;
export default async req => {
  app ||= makeApp({ db: supabaseDb({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY }), env: process.env });
  return app.handle(req);
};
export const config = { path: '/api/*' };
