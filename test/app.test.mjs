import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeApp } from '../lib/app.mjs';
import { memoryDb } from '../lib/db-memory.mjs';
import { dokuSignature } from '../lib/integrations.mjs';

// ── harness ──
function setup() {
  const db = memoryDb(), calls = [];
  let clock = new Date('2026-11-11T03:00:00Z');
  const fakeFetch = async (url, init = {}) => {
    calls.push({ url, init });
    const J = (d, s = 200) => new Response(JSON.stringify(d), { status: s });
    if (url.includes('turnstile')) return J({ success: String(init.body).includes('response=good') });
    if (url.includes('midtrans.com/snap')) return J({ token: 'snap-tok', redirect_url: 'https://pay.midtrans.test/x' });
    if (url.includes('doku.com/checkout')) return J({ response: { payment: { url: 'https://pay.doku.test/y', token_id: 'dk' } } });
    if (url.includes('biteship.com/v1/rates')) return J({ pricing: [{ courier_code: 'jne', courier_service_code: 'reg', courier_name: 'JNE', courier_service_name: 'Reg', price: 18000, duration: '2-3 days' }] });
    if (url.includes('biteship.com/v1/orders')) return J({ id: 'bs-1', status: 'confirmed', courier: { waybill_id: 'WB123' } });
    return J({}, 404);
  };
  const env = { SESSION_SECRET: 's'.repeat(40), MASTER_KEY: 'm'.repeat(40), SUPER_SETUP_KEY: 'super-setup-key-1', PLATFORM_DOMAIN: 'shop.test', PUBLIC_BASE_URL: 'https://shop.test', CRON_SECRET: 'cron-secret' };
  const app = makeApp({ db, env, fetch: fakeFetch, now: () => clock });
  async function call(method, path, { body, tenant, token, headers = {}, raw } = {}) {
    const h = { 'content-type': 'application/json', ...headers };
    if (tenant) h['x-tenant'] = tenant;
    if (token) h.authorization = 'Bearer ' + token;
    const r = await app.handle(new Request('https://shop.test' + path, { method, headers: h, body: raw ?? (body ? JSON.stringify(body) : undefined) }));
    return { status: r.status, body: await r.json() };
  }
  return { db, app, call, calls, env, tick: ms => { clock = new Date(clock.getTime() + ms); } };
}

// a live store with two warehouses (Jakarta + Bandung), one product, stock and a courier zone
async function liveStore(h, slug = 'butter') {
  const su = await h.call('POST', '/api/signup', { body: { slug, store_name: 'Butter ' + slug, email: `o@${slug}.test`, password: 'password-123' } });
  assert.equal(su.status, 201, JSON.stringify(su.body));
  if (!(await h.db.one('users', { role: 'super' }))) await h.call('POST', '/api/super/setup', { body: { key: 'super-setup-key-1', email: 'me@x.test', password: 'super-password-1' } });
  const sup = await h.call('POST', '/api/login', { body: { email: 'me@x.test', password: 'super-password-1' } });
  const t = await h.db.one('tenants', { slug });
  assert.equal((await h.call('POST', `/api/super/tenants/${t.id}/approve`, { token: sup.body.token })).status, 200);
  const tok = su.body.token, o = { tenant: slug, token: tok };
  const jkt = (await h.call('POST', '/api/admin/warehouses', { ...o, body: { name: 'Jakarta', lat: -6.2, lng: 106.8, postal_code: '10110' } })).body.row;
  const bdg = (await h.call('POST', '/api/admin/warehouses', { ...o, body: { name: 'Bandung', lat: -6.9, lng: 107.6, postal_code: '40111' } })).body.row;
  const p = (await h.call('POST', '/api/admin/products', { ...o, body: { name: 'Butter Cookie' } })).body.row;
  const v = (await h.call('POST', '/api/admin/variants', { ...o, body: { product_id: p.id, name: 'Box of 6', price: 50000, weight_g: 400 } })).body.row;
  await h.call('PUT', '/api/admin/stock', { ...o, body: { warehouse_id: jkt.id, variant_id: v.id, qty: 2 } });
  await h.call('PUT', '/api/admin/stock', { ...o, body: { warehouse_id: bdg.id, variant_id: v.id, qty: 10 } });
  await h.call('POST', '/api/admin/zones', { ...o, body: { name: 'City', max_km: 15, fee: 10000 } });
  return { slug, tok, o, jkt, bdg, p, v, t };
}
const JKT_CUSTOMER = { address: 'Jl. Test 1', lat: -6.21, lng: 106.82, postal_code: '10220' };
const customer = { name: 'Ana', phone: '0812-3456-7890' };

test('sign-up: store stays hidden until the super-admin approves it', async () => {
  const h = setup();
  const su = await h.call('POST', '/api/signup', { body: { slug: 'cake', store_name: 'Cake', email: 'a@cake.test', password: 'password-123' } });
  assert.equal(su.status, 201);
  assert.equal((await h.call('GET', '/api/store', { tenant: 'cake' })).status, 404);
  assert.equal((await h.call('POST', '/api/signup', { body: { slug: 'cake', store_name: 'X', email: 'b@x.test', password: 'password-123' } })).body.error, 'slug_taken');
  assert.equal((await h.call('POST', '/api/signup', { body: { slug: 'admin', store_name: 'X', email: 'b@x.test', password: 'password-123' } })).body.error, 'bad_slug');
  // owner can already set up the shop while pending
  assert.equal((await h.call('PUT', '/api/admin/theme', { tenant: 'cake', token: su.body.token, body: { primary: '#112233' } })).status, 200);
  await h.call('POST', '/api/super/setup', { body: { key: 'super-setup-key-1', email: 'me@x.test', password: 'super-password-1' } });
  assert.equal((await h.call('POST', '/api/super/setup', { body: { key: 'super-setup-key-1', email: 'z@x.test', password: 'super-password-1' } })).status, 409);
  const sup = await h.call('POST', '/api/login', { body: { email: 'me@x.test', password: 'super-password-1' } });
  const t = await h.db.one('tenants', { slug: 'cake' });
  await h.call('POST', `/api/super/tenants/${t.id}/approve`, { token: sup.body.token });
  const st = await h.call('GET', '/api/store', { tenant: 'cake' });
  assert.equal(st.status, 200); assert.equal(st.body.theme.primary, '#112233'); assert.equal(st.body.theme.font, 'Plus Jakarta Sans');
  assert.deepEqual((await h.call('GET', '/api/directory')).body.stores.map(s => s.slug), ['cake']);
  // a store owner is not a super-admin
  assert.equal((await h.call('GET', '/api/super/tenants', { token: su.body.token })).status, 401);
});

test('tenants are isolated from each other', async () => {
  const h = setup(); const A = await liveStore(h, 'alpha'), B = await liveStore(h, 'bravo');
  assert.equal((await h.call('GET', '/api/admin/orders', { tenant: 'bravo', token: A.tok })).status, 401, "A's login can't open B's back office");
  assert.equal((await h.call('PATCH', `/api/admin/products/${B.p.id}`, { tenant: 'alpha', token: A.tok, body: { name: 'hacked' } })).status, 404);
  assert.equal((await h.call('POST', '/api/admin/variants', { tenant: 'alpha', token: A.tok, body: { product_id: B.p.id, name: 'x', price: 1 } })).body.error, 'bad_product');
  assert.equal((await h.call('PUT', '/api/admin/stock', { tenant: 'alpha', token: A.tok, body: { warehouse_id: B.jkt.id, variant_id: B.v.id, qty: 99 } })).body.error, 'bad_ref');
  // B's product can't be bought in A's shop
  const q = await h.call('POST', '/api/quote', { tenant: 'alpha', body: { items: [{ variant_id: B.v.id, qty: 1 }], destination: JKT_CUSTOMER } });
  assert.equal(q.body.error, 'unavailable');
  // the same email can own a store in each tenant; login is per store
  assert.equal((await h.call('POST', '/api/login', { tenant: 'bravo', body: { email: 'o@alpha.test', password: 'password-123' } })).status, 401);
});

test('theme and settings are validated', async () => {
  const h = setup(); const S = await liveStore(h);
  assert.equal((await h.call('PUT', '/api/admin/theme', { ...S.o, body: { primary: 'red' } })).body.error, 'bad_theme');
  assert.equal((await h.call('PUT', '/api/admin/theme', { ...S.o, body: { font: 'Comic Sans' } })).body.error, 'bad_theme');
  assert.equal((await h.call('PUT', '/api/admin/theme', { ...S.o, body: { logo: 'javascript:alert(1)' } })).body.error, 'bad_theme');
  const ok = await h.call('PUT', '/api/admin/theme', { ...S.o, body: { primary: '#0A7B5C', font: 'Poppins', layout: 'list', mode: 'dark', radius: 8 } });
  assert.deepEqual([ok.body.theme.primary, ok.body.theme.font, ok.body.theme.layout], ['#0A7B5C', 'Poppins', 'list']);
  assert.equal((await h.call('PUT', '/api/admin/settings', { ...S.o, body: { payments: ['paypal'] } })).body.error, 'bad_settings');
});

test('API keys are stored encrypted and shown masked', async () => {
  const h = setup(); const S = await liveStore(h);
  await h.call('PUT', '/api/admin/secrets/midtrans', { ...S.o, body: { serverKey: 'SB-Mid-server-SECRET1234', clientKey: 'SB-Mid-client-abc' } });
  const raw = JSON.stringify(h.db._tables.tenant_secrets);
  assert.ok(!raw.includes('SECRET1234'), 'plain key must never reach the database');
  const g = await h.call('GET', '/api/admin/secrets', S.o);
  assert.equal(g.body.midtrans.fields.serverKey, '••••1234');
  assert.equal(g.body.midtrans.fields.clientKey, 'SB-Mid-client-abc');
  assert.equal(g.body.midtrans.notify_url, 'https://shop.test/api/webhook/midtrans/butter');
  // staff can't see or change keys
  await h.call('POST', '/api/admin/staff', { ...S.o, body: { email: 'st@b.test', password: 'password-123' } });
  const st = await h.call('POST', '/api/login', { tenant: 'butter', body: { email: 'st@b.test', password: 'password-123' } });
  assert.equal((await h.call('GET', '/api/admin/secrets', { tenant: 'butter', token: st.body.token })).status, 401);
});

test('multi-warehouse: nearest warehouse with enough stock ships the order', async () => {
  const h = setup(); const S = await liveStore(h);
  const q1 = await h.call('POST', '/api/quote', { tenant: 'butter', body: { items: [{ variant_id: S.v.id, qty: 2 }], destination: JKT_CUSTOMER } });
  assert.equal(q1.body.warehouse.name, 'Jakarta');
  assert.ok(q1.body.options.some(o => o.id.startsWith('store:') && o.fee === 10000), 'store courier zone offered in the city');
  const q2 = await h.call('POST', '/api/quote', { tenant: 'butter', body: { items: [{ variant_id: S.v.id, qty: 3 }], destination: JKT_CUSTOMER } });
  assert.equal(q2.body.warehouse.name, 'Bandung', 'Jakarta only has 2, so Bandung ships');
  assert.ok(!q2.body.options.some(o => o.provider === 'store'), 'Bandung is out of the 15 km courier zone');
  const q3 = await h.call('POST', '/api/quote', { tenant: 'butter', body: { items: [{ variant_id: S.v.id, qty: 13 }], destination: JKT_CUSTOMER } });
  assert.equal(q3.status, 409); assert.equal(q3.body.error, 'out_of_stock');
});

test('checkout with Midtrans: server prices, stock reserved, signed webhook marks paid once', async () => {
  const h = setup(); const S = await liveStore(h);
  await h.call('PUT', '/api/admin/secrets/midtrans', { ...S.o, body: { serverKey: 'srv-key', clientKey: 'cli' } });
  await h.call('PUT', '/api/admin/settings', { ...S.o, body: { payments: ['midtrans', 'manual'] } });
  const q = await h.call('POST', '/api/quote', { tenant: 'butter', body: { items: [{ variant_id: S.v.id, qty: 2 }], destination: JKT_CUSTOMER } });
  const ship = q.body.options.find(o => o.provider === 'store');
  const co = await h.call('POST', '/api/checkout', { tenant: 'butter', body: { items: [{ variant_id: S.v.id, qty: 2, price: 1 }], destination: JKT_CUSTOMER, customer, shipping_id: ship.id, payment: 'midtrans' } });
  assert.equal(co.status, 200, JSON.stringify(co.body));
  assert.equal(co.body.order.total, 2 * 50000 + 10000, 'client price ignored');
  assert.equal(co.body.order.payment.url, 'https://pay.midtrans.test/x');
  let s = await h.db.one('stock', { warehouse_id: S.jkt.id, variant_id: S.v.id });
  assert.deepEqual([s.qty, s.reserved], [2, 2]);
  // the same 2 units can't be sold twice
  const again = await h.call('POST', '/api/quote', { tenant: 'butter', body: { items: [{ variant_id: S.v.id, qty: 1 }], destination: JKT_CUSTOMER } });
  assert.equal(again.body.warehouse.name, 'Bandung');

  const no = co.body.order.no, gross = '110000.00';
  const forged = { order_id: no, status_code: '200', gross_amount: gross, transaction_status: 'settlement', signature_key: 'nope' };
  assert.equal((await h.call('POST', '/api/webhook/midtrans/butter', { body: forged })).status, 401);
  const sig = crypto.createHash('sha512').update(no + '200' + gross + 'srv-key').digest('hex');
  const good = { ...forged, signature_key: sig, transaction_id: 'trx-1', payment_type: 'qris' };
  assert.equal((await h.call('POST', '/api/webhook/midtrans/butter', { body: good })).body.result, 'paid');
  assert.equal((await h.call('POST', '/api/webhook/midtrans/butter', { body: good })).body.result, 'unchanged', 'repeated webhook is harmless');
  s = await h.db.one('stock', { warehouse_id: S.jkt.id, variant_id: S.v.id });
  assert.deepEqual([s.qty, s.reserved], [0, 0]);
  const look = await h.call('GET', `/api/order?no=${no}&phone=6281234567890`, { tenant: 'butter' });
  assert.equal(look.body.order.status, 'paid');
  assert.equal((await h.call('GET', `/api/order?no=${no}&phone=0899999999`, { tenant: 'butter' })).status, 404);
});

test('checkout with DOKU and a signed notification', async () => {
  const h = setup(); const S = await liveStore(h);
  await h.call('PUT', '/api/admin/secrets/doku', { ...S.o, body: { clientId: 'BRN-1', secretKey: 'doku-secret' } });
  await h.call('PUT', '/api/admin/settings', { ...S.o, body: { payments: ['doku'] } });
  const q = await h.call('POST', '/api/quote', { tenant: 'butter', body: { items: [{ variant_id: S.v.id, qty: 1 }], destination: JKT_CUSTOMER } });
  const co = await h.call('POST', '/api/checkout', { tenant: 'butter', body: { items: [{ variant_id: S.v.id, qty: 1 }], destination: JKT_CUSTOMER, customer, shipping_id: q.body.options[0].id, payment: 'doku' } });
  assert.equal(co.body.order.payment.url, 'https://pay.doku.test/y');
  const req = h.calls.find(c => c.url.includes('doku.com'));
  assert.match(req.init.headers.Signature, /^HMACSHA256=/);
  const raw = JSON.stringify({ order: { invoice_number: co.body.order.no, amount: co.body.order.total }, transaction: { status: 'SUCCESS' } });
  const hd = { 'client-id': 'BRN-1', 'request-id': 'r1', 'request-timestamp': '2026-11-11T03:01:00Z' };
  const target = '/api/webhook/doku/butter';
  const bad = await h.call('POST', target, { raw, headers: { ...hd, signature: 'HMACSHA256=xxx' } });
  assert.equal(bad.status, 401);
  const signature = dokuSignature({ clientId: 'BRN-1', secretKey: 'doku-secret', requestId: 'r1', timestamp: hd['request-timestamp'], target, body: raw });
  assert.equal((await h.call('POST', target, { raw, headers: { ...hd, signature } })).body.result, 'paid');
});

test('Biteship rates, shipping integrity and booking with tracking webhook', async () => {
  const h = setup(); const S = await liveStore(h);
  await h.call('PUT', '/api/admin/secrets/biteship', { ...S.o, body: { apiKey: 'bs-key' } });
  await h.call('PUT', '/api/admin/settings', { ...S.o, body: { biteship: true, payments: ['manual'] } });
  const q = await h.call('POST', '/api/quote', { tenant: 'butter', body: { items: [{ variant_id: S.v.id, qty: 1 }], destination: JKT_CUSTOMER } });
  const jne = q.body.options.find(o => o.id === 'biteship:jne:reg'); assert.equal(jne.fee, 18000);
  assert.equal((await h.call('POST', '/api/checkout', { tenant: 'butter', body: { items: [{ variant_id: S.v.id, qty: 1 }], destination: JKT_CUSTOMER, customer, shipping_id: 'biteship:jne:yes', payment: 'manual' } })).body.error, 'shipping_changed');
  const co = await h.call('POST', '/api/checkout', { tenant: 'butter', body: { items: [{ variant_id: S.v.id, qty: 1 }], destination: JKT_CUSTOMER, customer, shipping_id: jne.id, payment: 'manual' } });
  assert.equal(co.body.order.total, 68000);
  const no = co.body.order.no;
  assert.equal((await h.call('POST', `/api/admin/orders/${no}/book`, S.o)).body.error, 'not_paid');
  assert.equal((await h.call('POST', `/api/admin/orders/${no}/confirm-payment`, S.o)).body.result, 'paid');
  const bk = await h.call('POST', `/api/admin/orders/${no}/book`, S.o);
  assert.equal(bk.body.booking.waybill, 'WB123');
  const secrets = await h.call('GET', '/api/admin/secrets', S.o);
  const hook = new URL(secrets.body.biteship.webhook_url).pathname;
  assert.equal((await h.call('POST', '/api/webhook/biteship/butter/wrong', { body: { order_id: 'bs-1', status: 'delivered' } })).status, 401);
  await h.call('POST', hook, { body: { order_id: 'bs-1', status: 'delivered', courier_waybill_id: 'WB123' } });
  assert.equal((await h.call('GET', `/api/order?no=${no}&phone=081234567890`, { tenant: 'butter' })).body.order.status, 'delivered');
});

test('Turnstile is enforced once a store adds its keys', async () => {
  const h = setup(); const S = await liveStore(h);
  await h.call('PUT', '/api/admin/secrets/turnstile', { ...S.o, body: { siteKey: '0x-site', secretKey: '0x-secret' } });
  assert.equal((await h.call('GET', '/api/store', { tenant: 'butter' })).body.turnstile_site_key, '0x-site');
  const q = await h.call('POST', '/api/quote', { tenant: 'butter', body: { items: [{ variant_id: S.v.id, qty: 1 }], destination: JKT_CUSTOMER } });
  const body = { items: [{ variant_id: S.v.id, qty: 1 }], destination: JKT_CUSTOMER, customer, shipping_id: q.body.options[0].id, payment: 'manual' };
  assert.equal((await h.call('POST', '/api/checkout', { tenant: 'butter', body })).body.error, 'turnstile_failed');
  assert.equal((await h.call('POST', '/api/checkout', { tenant: 'butter', body: { ...body, turnstile: 'bad' } })).body.error, 'turnstile_failed');
  assert.equal((await h.call('POST', '/api/checkout', { tenant: 'butter', body: { ...body, turnstile: 'good' } })).status, 200);
});

test('unpaid orders expire and give stock back; late payment re-reserves if possible', async () => {
  const h = setup(); const S = await liveStore(h);
  await h.call('PUT', '/api/admin/secrets/midtrans', { ...S.o, body: { serverKey: 'srv-key' } });
  await h.call('PUT', '/api/admin/settings', { ...S.o, body: { payments: ['midtrans'], pay_minutes: 30 } });
  const q = await h.call('POST', '/api/quote', { tenant: 'butter', body: { items: [{ variant_id: S.v.id, qty: 2 }], destination: JKT_CUSTOMER } });
  const co = await h.call('POST', '/api/checkout', { tenant: 'butter', body: { items: [{ variant_id: S.v.id, qty: 2 }], destination: JKT_CUSTOMER, customer, shipping_id: 'pickup', payment: 'midtrans' } });
  h.tick(31 * 60000);
  assert.equal(await h.app.sweep(), 1);
  let s = await h.db.one('stock', { warehouse_id: S.jkt.id, variant_id: S.v.id });
  assert.equal(s.reserved, 0);
  const no = co.body.order.no, gross = String(co.body.order.total);
  const sig = crypto.createHash('sha512').update(no + '200' + gross + 'srv-key').digest('hex');
  const r = await h.call('POST', '/api/webhook/midtrans/butter', { body: { order_id: no, status_code: '200', gross_amount: gross, transaction_status: 'settlement', signature_key: sig } });
  assert.equal(r.body.result, 'paid_late');
  s = await h.db.one('stock', { warehouse_id: S.jkt.id, variant_id: S.v.id });
  assert.deepEqual([s.qty, s.reserved], [0, 0]);
  // stock can't be set below what unpaid orders hold
  const q2 = await h.call('POST', '/api/quote', { tenant: 'butter', body: { items: [{ variant_id: S.v.id, qty: 4 }], destination: JKT_CUSTOMER } });
  await h.call('POST', '/api/checkout', { tenant: 'butter', body: { items: [{ variant_id: S.v.id, qty: 4 }], destination: JKT_CUSTOMER, customer, shipping_id: q2.body.options[0]?.id || 'x', payment: 'midtrans' } });
  assert.equal((await h.call('PUT', '/api/admin/stock', { ...S.o, body: { warehouse_id: S.bdg.id, variant_id: S.v.id, qty: 1 } })).body.error, 'below_reserved');
});

test('menu shows availability summed over warehouses; order status flow is enforced', async () => {
  const h = setup(); const S = await liveStore(h);
  const m = await h.call('GET', '/api/menu', { tenant: 'butter' });
  assert.equal(m.body.products[0].variants[0].available, 12);
  const q = await h.call('POST', '/api/quote', { tenant: 'butter', body: { items: [{ variant_id: S.v.id, qty: 1 }], destination: JKT_CUSTOMER } });
  const co = await h.call('POST', '/api/checkout', { tenant: 'butter', body: { items: [{ variant_id: S.v.id, qty: 1 }], destination: JKT_CUSTOMER, customer, shipping_id: q.body.options[0].id, payment: 'manual' } });
  const no = co.body.order.no;
  assert.equal((await h.call('PATCH', `/api/admin/orders/${no}`, { ...S.o, body: { status: 'shipped' } })).body.error, 'bad_transition');
  // pickup at a chosen store works without an address
  const pk = await h.call('POST', '/api/checkout', { tenant: 'butter', body: { items: [{ variant_id: S.v.id, qty: 1 }], customer, shipping_id: 'pickup', pickup_warehouse_id: S.bdg.id, payment: 'manual' } });
  assert.equal(pk.body.order.shipping.label, 'Pick up at Bandung');
  assert.equal((await h.call('PATCH', `/api/admin/orders/${no}`, { ...S.o, body: { status: 'cancelled' } })).status, 200);
  assert.equal((await h.db.one('stock', { warehouse_id: S.jkt.id, variant_id: S.v.id })).reserved, 0);
});

// ───────────────────────── discounts, business accounts, reviews, complaints ─────────────────────────
async function placePickup(h, S, { qty = 1, coupon, token, payment = 'manual' } = {}) {
  return h.call('POST', '/api/checkout', { tenant: 'butter', token, body: { items: [{ variant_id: S.v.id, qty }], customer, shipping_id: 'pickup', pickup_warehouse_id: S.bdg.id, payment, coupon } });
}
async function deliver(h, S, no) {
  await h.call('POST', `/api/admin/orders/${no}/confirm-payment`, S.o);
  for (const status of ['preparing', 'shipped', 'delivered']) assert.equal((await h.call('PATCH', `/api/admin/orders/${no}`, { ...S.o, body: { status } })).status, 200);
}
const createCoupon = (h, S, body) => h.call('POST', '/api/admin/coupons', { ...S.o, body });
const couponRow = (h, code) => h.db.one('coupons', { code });

test('coupons: percent and fixed, minimum spend, expiry, single-use, released when an unpaid order is cancelled', async () => {
  const h = setup(); const S = await liveStore(h);
  assert.equal((await createCoupon(h, S, { code: 'bad code!', type: 'pct', value: 10 })).body.error, 'bad_code');
  assert.equal((await createCoupon(h, S, { code: 'SAVE10', type: 'pct', value: 10, min_purchase: 80000, max_uses: 1 })).status, 200);
  assert.equal((await createCoupon(h, S, { code: 'save10', type: 'pct', value: 5 })).body.error, 'exists', 'codes are case-insensitive');
  await createCoupon(h, S, { code: 'OLD', type: 'amt', value: 5000, expires_at: '2026-01-01T00:00:00Z' });
  await createCoupon(h, S, { code: 'FIVE', type: 'amt', value: 5000 });

  const quote = (coupon, qty = 2) => h.call('POST', '/api/quote', { tenant: 'butter', body: { items: [{ variant_id: S.v.id, qty }], pickup: true, pickup_warehouse_id: S.bdg.id, coupon } });
  assert.equal((await quote('SAVE10', 1)).body.pricing.coupon_error, 'Minimum purchase IDR 80,000 for this coupon.');
  assert.equal((await quote('NOPE')).body.pricing.coupon_error, 'Sorry, that code is not valid.');
  assert.equal((await quote('OLD')).body.pricing.coupon_error, 'This coupon has expired.');
  const ok = (await quote('save10')).body.pricing; assert.deepEqual([ok.coupon, ok.coupon_discount], ['SAVE10', 10000]);
  assert.equal((await quote('FIVE')).body.pricing.coupon_discount, 5000);

  assert.equal((await placePickup(h, S, { qty: 2, coupon: 'NOPE' })).body.error, 'coupon', 'checkout refuses a bad code');
  const a = await placePickup(h, S, { qty: 2, coupon: 'SAVE10' });
  assert.equal(a.body.order.total, 90000); assert.equal(a.body.order.coupon_discount, 10000);
  assert.equal((await couponRow(h, 'SAVE10')).used, 1);
  const b = await placePickup(h, S, { qty: 2, coupon: 'SAVE10' });
  assert.equal(b.body.error, 'coupon'); assert.match(b.body.message, /fully redeemed/);
  const stock = await h.db.one('stock', { warehouse_id: S.bdg.id, variant_id: S.v.id });
  assert.equal(stock.reserved, 2, 'the refused order must not keep stock reserved');
  // cancelling the unpaid order gives the use back
  await h.call('PATCH', `/api/admin/orders/${a.body.order.no}`, { ...S.o, body: { status: 'cancelled' } });
  assert.equal((await couponRow(h, 'SAVE10')).used, 0);
  assert.equal((await placePickup(h, S, { qty: 2, coupon: 'SAVE10' })).status, 200);
  // a fixed coupon can never push the price below zero
  await createCoupon(h, S, { code: 'HUGE', type: 'amt', value: 9999999 });
  assert.equal((await placePickup(h, S, { qty: 1, coupon: 'HUGE' })).body.order.total, 0);
});

test('volume discount and business accounts', async () => {
  const h = setup(); const S = await liveStore(h);
  await h.call('PUT', '/api/admin/settings', { ...S.o, body: { tiers: { regular: { qty: 3, amt: 0, pct: 10 }, b2b: { qty: 1, amt: 0, pct: 20 } } } });
  assert.equal((await h.call('PUT', '/api/admin/settings', { ...S.o, body: { tiers: { regular: { qty: 3, amt: 0, pct: 90 } } } })).body.error, 'bad_settings');
  assert.equal((await placePickup(h, S, { qty: 2 })).body.order.total, 100000, 'below the minimum: no discount');
  const three = await placePickup(h, S, { qty: 3 }); assert.equal(three.body.order.tier_discount, 15000); assert.equal(three.body.order.total, 135000);

  const acct = await h.call('POST', '/api/admin/b2b', { ...S.o, body: { name: 'Cafe Biru', login: 'cafe.biru', password: 'password-123', phone: '0811' } });
  assert.equal(acct.status, 200); assert.ok(!('cred' in acct.body.row), 'password hash never leaves the server');
  assert.equal((await h.call('POST', '/api/admin/b2b', { ...S.o, body: { name: 'X', login: 'CAFE.BIRU', password: 'password-123' } })).body.error, 'exists');
  assert.equal((await h.call('POST', '/api/b2b/login', { tenant: 'butter', body: { login: 'cafe.biru', password: 'wrong-password' } })).status, 401);
  const login = await h.call('POST', '/api/b2b/login', { tenant: 'butter', body: { login: 'Cafe.Biru', password: 'password-123' } });
  assert.equal(login.status, 200);
  const tok = login.body.token;
  const biz = await placePickup(h, S, { qty: 1, token: tok });
  assert.equal(biz.body.order.tier_discount, 10000, '20% business tier even for one item');
  assert.equal((await h.call('GET', '/api/me', { tenant: 'butter', token: tok })).body.business, 'Cafe Biru');
  // a business login is not staff
  assert.equal((await h.call('GET', '/api/admin/orders', { tenant: 'butter', token: tok })).status, 401);
  // it only counts in the store that issued it
  const B = await liveStore(h, 'other');
  await h.call('PUT', '/api/admin/settings', { ...B.o, body: { tiers: { b2b: { qty: 1, amt: 0, pct: 20 } } } });
  const q = await h.call('POST', '/api/quote', { tenant: 'other', token: tok, body: { items: [{ variant_id: B.v.id, qty: 1 }], pickup: true, pickup_warehouse_id: B.bdg.id } });
  assert.equal(q.body.pricing.tier_discount, 0);
  // switching the account off ends business pricing at once
  await h.call('PATCH', `/api/admin/b2b/${acct.body.row.id}`, { ...S.o, body: { active: false } });
  assert.equal((await placePickup(h, S, { qty: 1, token: tok })).body.order.tier_discount, 0);
  assert.equal((await h.call('POST', '/api/b2b/login', { tenant: 'butter', body: { login: 'cafe.biru', password: 'password-123' } })).status, 401);
  // staff cannot manage business accounts
  await h.call('POST', '/api/admin/staff', { ...S.o, body: { email: 'st@b.test', password: 'password-123' } });
  const st = await h.call('POST', '/api/login', { tenant: 'butter', body: { email: 'st@b.test', password: 'password-123' } });
  assert.equal((await h.call('GET', '/api/admin/b2b', { tenant: 'butter', token: st.body.token })).status, 401);
});

test('discounted orders send the gateway one line that equals the charged amount', async () => {
  const h = setup(); const S = await liveStore(h);
  await h.call('PUT', '/api/admin/secrets/midtrans', { ...S.o, body: { serverKey: 'srv-key' } });
  await h.call('PUT', '/api/admin/settings', { ...S.o, body: { payments: ['midtrans'] } });
  await createCoupon(h, S, { code: 'TEN', type: 'pct', value: 10 });
  const plain = await placePickup(h, S, { qty: 2, payment: 'midtrans' });
  const body1 = JSON.parse(h.calls.at(-1).init.body); assert.equal(body1.item_details.length, 1, 'one item line + no shipping for pickup');
  const disc = await placePickup(h, S, { qty: 2, payment: 'midtrans', coupon: 'TEN' });
  const body2 = JSON.parse(h.calls.at(-1).init.body);
  assert.equal(body2.transaction_details.gross_amount, 90000);
  assert.equal(body2.item_details.reduce((n, i) => n + i.price * i.quantity, 0), 90000);
  assert.ok(plain.status === 200 && disc.status === 200);
  // paying the discounted order: the webhook must carry the discounted amount
  const no = disc.body.order.no, sig = (amt) => crypto.createHash('sha512').update(no + '200' + amt + 'srv-key').digest('hex');
  const wrong = await h.call('POST', '/api/webhook/midtrans/butter', { body: { order_id: no, status_code: '200', gross_amount: '100000', transaction_status: 'settlement', signature_key: sig('100000') } });
  assert.match(wrong.body.note, /amount mismatch/);
  const right = await h.call('POST', '/api/webhook/midtrans/butter', { body: { order_id: no, status_code: '200', gross_amount: '90000', transaction_status: 'settlement', signature_key: sig('90000') } });
  assert.equal(right.body.result, 'paid');
});

test('reviews: only after delivery, once per item, shown with an average on the menu', async () => {
  const h = setup(); const S = await liveStore(h);
  const o = (await placePickup(h, S, { qty: 1 })).body.order, review = body => h.call('POST', '/api/review', { tenant: 'butter', body: { no: o.no, phone: '0812-3456-7890', product_id: S.p.id, ...body } });
  assert.equal((await review({ stars: 5 })).body.error, 'not_delivered');
  await deliver(h, S, o.no);
  assert.equal((await review({ stars: 7 })).body.error, 'bad_stars');
  assert.equal((await review({ stars: 4, product_id: 'nope' })).body.error, 'bad_item');
  assert.equal((await h.call('POST', '/api/review', { tenant: 'butter', body: { no: o.no, phone: '0899999999', product_id: S.p.id, stars: 5 } })).status, 404, 'wrong phone');
  assert.equal((await review({ stars: 5, text: 'Soft and buttery' })).status, 200);
  assert.equal((await review({ stars: 1 })).body.error, 'exists');
  const second = (await placePickup(h, S, { qty: 1 })).body.order; await deliver(h, S, second.no);
  await h.call('POST', '/api/review', { tenant: 'butter', body: { no: second.no, phone: '081234567890', product_id: S.p.id, stars: 4 } });
  const menu = (await h.call('GET', '/api/menu', { tenant: 'butter' })).body.products[0];
  assert.deepEqual(menu.rating, { avg: 4.5, count: 2 });
  const list = (await h.call('GET', '/api/reviews', { tenant: 'butter' })).body.reviews;
  assert.equal(list.length, 2); assert.equal(list.find(r => r.text).name, 'Ana');
  const look = (await h.call('GET', `/api/order?no=${o.no}&phone=081234567890`, { tenant: 'butter' })).body.order;
  assert.deepEqual(look.reviewed, [S.p.id]);
  // the store can remove a review
  const rows = (await h.call('GET', '/api/admin/reviews', S.o)).body.rows;
  assert.equal((await h.call('DELETE', `/api/admin/reviews/${rows[0].id}`, S.o)).status, 200);
  assert.equal((await h.call('GET', '/api/menu', { tenant: 'butter' })).body.products[0].rating.count, 1);
});

test('complaints: delivered orders only, photos required, one per order, closes after the window', async () => {
  const h = setup(); const S = await liveStore(h);
  const IMG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
  const o = (await placePickup(h, S, { qty: 1 })).body.order;
  const complain = (body, no = o.no) => h.call('POST', '/api/complaint', { tenant: 'butter', body: { no, phone: '081234567890', reason: 'Damaged item', text: 'The box arrived crushed', imgs: [IMG], ...body } });
  assert.equal((await complain({})).body.error, 'not_delivered');
  await deliver(h, S, o.no);
  const view = (await h.call('GET', `/api/order?no=${o.no}&phone=081234567890`, { tenant: 'butter' })).body.order;
  assert.equal(view.can_complain, true);
  assert.equal((await complain({ imgs: [] })).body.error, 'bad_img');
  assert.equal((await complain({ imgs: ['http://evil.test/x.png'] })).body.error, 'bad_img');
  assert.equal((await complain({ imgs: ['data:image/svg+xml;base64,PHN2Zz4='] })).body.error, 'bad_img', 'only jpeg or webp');
  assert.equal((await complain({ text: 'bad' })).body.error, 'bad_text');
  assert.equal((await complain({})).status, 200);
  assert.equal((await complain({})).body.error, 'exists');
  assert.equal((await h.call('GET', `/api/order?no=${o.no}&phone=081234567890`, { tenant: 'butter' })).body.order.complaint.status, 'open');
  const list = (await h.call('GET', '/api/admin/complaints', S.o)).body.rows; assert.equal(list[0].reason, 'Damaged item');
  assert.deepEqual((await h.call('GET', `/api/admin/complaints/${o.no}/images`, S.o)).body.images, [IMG]);
  assert.equal((await h.call('PATCH', `/api/admin/complaints/${o.no}`, { ...S.o, body: { status: 'resolved', note: 'Refunded' } })).body.row.status, 'resolved');
  // another store can't read it
  const B = await liveStore(h, 'other');
  assert.equal((await h.call('GET', `/api/admin/complaints/${o.no}/images`, B.o)).status, 404);
  // the window closes (48 hours by default)
  const late = (await placePickup(h, S, { qty: 1 })).body.order; await deliver(h, S, late.no);
  h.tick(49 * 3600000);
  assert.equal((await complain({}, late.no)).body.error, 'closed');
  assert.equal((await h.call('GET', `/api/order?no=${late.no}&phone=081234567890`, { tenant: 'butter' })).body.order.can_complain, false);
});
