import { test } from 'node:test';
import assert from 'node:assert/strict';
import { supabaseDb } from '../lib/db-supabase.mjs';

test('Supabase adapter: filters, upserts and stock errors', async () => {
  const seen = [];
  const fake = async (url, init) => {
    seen.push({ url: decodeURIComponent(url), init });
    if (url.includes('rpc/reserve_stock')) return new Response('{"code":"P0001","message":"out_of_stock"}', { status: 400 });
    return new Response('[{"id":"1"}]', { status: 200 });
  };
  const db = supabaseDb({ url: 'https://p.supabase.co/', key: 'sb_secret_x', fetch: fake });
  await db.select('orders', { tenant_id: 't1', status: { in: ['paid', 'shipped'] }, expires_at: { lt: '2026-01-01' }, warehouse_id: null }, { order: 'created_at', desc: true, limit: 5 });
  assert.equal(seen[0].url, 'https://p.supabase.co/rest/v1/orders?select=*&tenant_id=eq.t1&status=in.("paid","shipped")&expires_at=lt.2026-01-01&warehouse_id=is.null&order=created_at.desc&limit=5');
  assert.equal(seen[0].init.headers.apikey, 'sb_secret_x');
  await db.upsert('stock', { warehouse_id: 'w', variant_id: 'v', qty: 1 });
  assert.match(seen[1].url, /stock\?on_conflict=warehouse_id,variant_id$/);
  assert.match(seen[1].init.headers.prefer, /merge-duplicates/);
  await assert.rejects(db.rpc('reserve_stock', {}), e => e.code === 'out_of_stock');
});
