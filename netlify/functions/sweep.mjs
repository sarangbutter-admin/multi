// Runs every 5 minutes: expires unpaid orders past their payment deadline and gives the stock back.
import { makeApp } from '../../lib/app.mjs';
import { supabaseDb } from '../../lib/db-supabase.mjs';

export default async () => {
  if (process.env.DEMO_MODE === '1') return;  // demo data lives in memory inside the api function
  const app = makeApp({ db: supabaseDb({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY }), env: process.env });
  console.log('expired orders:', await app.sweep());
};
export const config = { schedule: '*/5 * * * *' };
