// Sarang Order – multi-tenant API. One handler for every store; the tenant comes from the domain or the X-Tenant header.
import { rid, mkCred, checkPw, signSession, readSession, encrypt, decrypt, mask, safeEq } from './crypto.mjs';
import * as X from './integrations.mjs';
import { buildItems, pickWarehouse, availability, storeCourierOption, haversineKm } from './fulfil.mjs';

const E = (status, code, message) => Object.assign(new Error(message || code), { status, code });
const isObj = x => x && typeof x === 'object' && !Array.isArray(x);
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = v => (typeof v === 'number' && isFinite(v) ? v : v === '' || v == null ? null : isFinite(Number(v)) ? Number(v) : null);
const digits = p => String(p || '').replace(/\D/g, '');
const RESERVED_SLUGS = new Set(['www', 'api', 'app', 'admin', 'super', 'mail', 'static', 'cdn', 'help', 'status']);
const SLUG = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
const FONTS = ['Inter', 'Poppins', 'Nunito', 'DM Sans', 'Plus Jakarta Sans', 'Fredoka', 'Playfair Display', 'Space Grotesk'];
const PROVIDERS = {
  midtrans: { serverKey: 'secret', clientKey: 'public', production: 'bool' },
  doku: { clientId: 'public', secretKey: 'secret', production: 'bool' },
  biteship: { apiKey: 'secret', couriers: 'public' },
  turnstile: { siteKey: 'public', secretKey: 'secret' }
};
const ORDER_FLOW = { paid: ['preparing', 'cancelled'], preparing: ['shipped', 'cancelled'], shipped: ['delivered'], pending_payment: ['cancelled'] };

export const DEFAULT_THEME = { primary: '#E2522F', accent: '#FFC94A', background: '#FFF8F0', surface: '#FFFFFF', text: '#2B1B12', radius: 16, font: 'Nunito', mode: 'light', layout: 'grid', logo: '', banner: '' };

export function cleanTheme(t) {
  if (!isObj(t)) throw E(400, 'bad_theme');
  const out = {};
  for (const k of ['primary', 'accent', 'background', 'surface', 'text']) if (k in t) { if (!HEX.test(t[k])) throw E(400, 'bad_theme', `${k} must be a #RRGGBB colour`); out[k] = t[k]; }
  if ('radius' in t) { const r = num(t.radius); if (r == null || r < 0 || r > 32) throw E(400, 'bad_theme', 'radius 0–32'); out.radius = r; }
  if ('font' in t) { if (!FONTS.includes(t.font)) throw E(400, 'bad_theme', 'font must be one of: ' + FONTS.join(', ')); out.font = t.font; }
  if ('mode' in t) { if (!['light', 'dark'].includes(t.mode)) throw E(400, 'bad_theme'); out.mode = t.mode; }
  if ('layout' in t) { if (!['grid', 'list'].includes(t.layout)) throw E(400, 'bad_theme'); out.layout = t.layout; }
  for (const k of ['logo', 'banner']) if (k in t) { const u = str(t[k], 500); if (u && !/^https:\/\//.test(u) && !u.startsWith('/media/')) throw E(400, 'bad_theme', `${k} must be an https URL`); out[k] = u; }
  return out;
}

function cleanSettings(s) {
  if (!isObj(s)) throw E(400, 'bad_settings');
  const out = {};
  if ('pickup' in s) out.pickup = s.pickup === true;
  if ('payments' in s) {
    if (!Array.isArray(s.payments) || s.payments.some(p => !['midtrans', 'doku', 'manual'].includes(p))) throw E(400, 'bad_settings', 'payments: midtrans, doku, manual');
    out.payments = [...new Set(s.payments)];
  }
  if ('manual' in s) { const m = isObj(s.manual) ? s.manual : {}; out.manual = { bank: str(m.bank, 60), account_name: str(m.account_name, 80), account_no: str(m.account_no, 40), note: str(m.note, 300) }; }
  if ('pay_minutes' in s) { const m = num(s.pay_minutes); if (m == null || m < 15 || m > 1440) throw E(400, 'bad_settings', 'pay_minutes 15–1440'); out.pay_minutes = Math.round(m); }
  if ('biteship' in s) out.biteship = s.biteship === true;
  if ('about' in s) out.about = str(s.about, 1000);
  if ('whatsapp' in s) out.whatsapp = digits(s.whatsapp).slice(0, 16);
  return out;
}

const PICK = {
  warehouses: { name: v => str(v, 80) || null, address: v => str(v, 300), postal_code: v => digits(v).slice(0, 5) || null, area_id: v => str(v, 80) || null,
                lat: num, lng: num, priority: v => Math.round(num(v) || 0), active: v => v !== false, contact: v => (isObj(v) ? { name: str(v.name, 80), phone: digits(v.phone).slice(0, 16) } : {}) },
  products: { name: v => str(v, 120) || null, description: v => str(v, 2000), image: v => str(v, 500), category: v => str(v, 60), sort: v => Math.round(num(v) || 0), active: v => v !== false },
  variants: { product_id: v => str(v, 64) || null, name: v => str(v, 120) || null, sku: v => str(v, 60), price: v => { const n = num(v); if (n == null || n < 0 || !Number.isInteger(n)) throw E(400, 'bad_price', 'price must be a whole number'); return n; },
              weight_g: v => Math.max(Math.round(num(v) || 0), 0), active: v => v !== false },
  courier_zones: { warehouse_id: v => str(v, 64) || null, name: v => str(v, 60) || null, max_km: v => { const n = num(v); if (!(n > 0)) throw E(400, 'bad_zone', 'max_km must be > 0'); return n; },
                   fee: v => { const n = num(v); if (n == null || n < 0) throw E(400, 'bad_zone', 'fee must be ≥ 0'); return Math.round(n); }, eta: v => str(v, 40) }
};
const REQUIRED = { warehouses: ['name'], products: ['name'], variants: ['product_id', 'name', 'price'], courier_zones: ['name', 'max_km', 'fee'] };
function pickFields(table, body, partial) {
  if (!isObj(body)) throw E(400, 'bad_body');
  const out = {};
  for (const [k, fn] of Object.entries(PICK[table])) if (k in body) out[k] = fn(body[k]);
  if (!partial) for (const k of REQUIRED[table]) if (out[k] == null) throw E(400, 'missing_' + k, k + ' is required');
  return out;
}

export function makeApp({ db, env = {}, fetch: f = fetch, now = () => new Date() }) {
  const SECRET = env.SESSION_SECRET, MASTER = env.MASTER_KEY;
  if (!SECRET || SECRET.length < 32) throw new Error('SESSION_SECRET (32+ chars) is required');
  if (!MASTER || MASTER.length < 32) throw new Error('MASTER_KEY (32+ chars) is required');
  const PLATFORM = String(env.PLATFORM_DOMAIN || '').toLowerCase();
  const BASE_URL = String(env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const ORIGINS = new Set(String(env.APP_ORIGINS || 'capacitor://localhost,https://localhost').split(',').map(s => s.trim()).filter(Boolean));

  // tiny per-instance rate limiter (login/sign-up). Turnstile is the main bot guard.
  const rl = new Map();
  const rlHit = (k, max, winMs) => { const t = Date.now(), r = rl.get(k); if (!r || t - r.t > winMs) { rl.set(k, { t, n: 1 }); return true; } return ++r.n <= max; };

  // ── tenant & secrets ──
  async function tenantBySlug(slug) { return SLUG.test(slug || '') ? db.one('tenants', { slug }) : null; }
  async function resolveTenant(req, url) {
    const hdr = (req.headers.get('x-tenant') || '').toLowerCase();
    if (hdr) return tenantBySlug(hdr);
    const host = url.hostname.toLowerCase();
    if (PLATFORM && host.endsWith('.' + PLATFORM)) return tenantBySlug(host.slice(0, -PLATFORM.length - 1));
    const d = await db.one('tenant_domains', { host });
    return d ? db.one('tenants', { id: d.tenant_id }) : null;
  }
  async function secretOf(tid, provider) { const r = await db.one('tenant_secrets', { tenant_id: tid, provider }); return r ? decrypt(MASTER, r.enc) : null; }
  const theme = t => ({ ...DEFAULT_THEME, ...(t.theme || {}) });

  // ── auth ──
  function sessionOf(req) {
    const auth = req.headers.get('authorization') || '';
    if (auth.startsWith('Bearer ')) return readSession(SECRET, auth.slice(7));
    const m = /(?:^|;\s*)so_sess=([^;]+)/.exec(req.headers.get('cookie') || '');
    return m ? readSession(SECRET, decodeURIComponent(m[1])) : null;
  }
  function staffOf(c, roles = ['owner', 'staff']) {
    if (!c.tenant) throw E(404, 'no_store', 'Store not found');
    if (!c.sess || c.sess.tid !== c.tenant.id || !roles.includes(c.sess.role)) throw E(401, 'login_required', 'Please log in');
    if (c.tenant.status === 'suspended') throw E(403, 'suspended', 'This store is suspended');
    return c.sess;
  }
  const superOf = c => { if (!c.sess || c.sess.role !== 'super' || c.sess.tid) throw E(401, 'login_required'); return c.sess; };
  const shop = c => { if (!c.tenant || c.tenant.status !== 'active') throw E(404, 'no_store', 'Store not found'); return c.tenant; };
  function issue(user) {
    const token = signSession(SECRET, { uid: user.id, tid: user.tenant_id || null, role: user.role });
    return { token, cookie: `so_sess=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200` };
  }
  async function turnstile(c, token, tenantId) {
    const ts = tenantId ? await secretOf(tenantId, 'turnstile') : (env.TURNSTILE_SECRET ? { secretKey: env.TURNSTILE_SECRET } : null);
    const r = await X.verifyTurnstile({ secret: ts?.secretKey, token, ip: c.ip, fetch: f });
    if (!r.ok) throw E(403, 'turnstile_failed', 'Please complete the security check');
  }

  // ── catalogue & shipping ──
  async function cart(t, raw) {
    const ids = [...new Set((Array.isArray(raw) ? raw : []).map(i => String(i?.variant_id || '')))].filter(Boolean).slice(0, 50);
    const variants = ids.length ? await db.select('variants', { tenant_id: t.id, id: { in: ids } }) : [];
    const products = variants.length ? await db.select('products', { tenant_id: t.id, id: { in: [...new Set(variants.map(v => v.product_id))] } }) : [];
    return buildItems(raw, variants, products);
  }
  function cleanDest(d) {
    if (!isObj(d)) throw E(400, 'bad_destination', 'Delivery address is required');
    const o = { address: str(d.address, 400), postal_code: digits(d.postal_code).slice(0, 5) || null, area_id: str(d.area_id, 80) || null, lat: num(d.lat), lng: num(d.lng), note: str(d.note, 200) };
    if (o.lat != null && (o.lat < -90 || o.lat > 90)) o.lat = null;
    if (o.lng != null && (o.lng < -180 || o.lng > 180)) o.lng = null;
    return o;
  }
  // pickupOnly: no address needed; the customer's location (if sent) still picks the nearest store,
  // or pickupAt names the store they chose.
  async function plan(t, rawItems, rawDest, pickupOnly, pickupAt) {
    const { items, subtotal } = await cart(t, rawItems);
    const dest = pickupOnly ? (isObj(rawDest) ? cleanDest(rawDest) : {}) : cleanDest(rawDest);
    const [whs, stock] = await Promise.all([
      db.select('warehouses', { tenant_id: t.id, active: true, ...(pickupOnly && pickupAt ? { id: String(pickupAt) } : {}) }),
      db.select('stock', { tenant_id: t.id, variant_id: { in: items.map(i => i.variant_id) } })
    ]);
    const pick = pickWarehouse(whs, stock, items, dest);
    if (!pick) throw E(409, 'out_of_stock', 'Sorry, part of your order is sold out');
    const s = t.settings || {}, opts = [], warnings = [];
    if (s.pickup) opts.push({ id: 'pickup', provider: 'pickup', courier: 'pickup', service: 'pickup', label: `Pick up at ${pick.warehouse.name}`, fee: 0, eta: '' });
    if (!pickupOnly) {
      const zones = await db.select('courier_zones', { tenant_id: t.id });
      const own = storeCourierOption(zones, pick.warehouse.id, pick.distanceKm); if (own) opts.push(own);
      if (s.biteship) {
        const b = await secretOf(t.id, 'biteship');
        if (b?.apiKey) {
          try { opts.push(...await X.biteshipRates({ key: b.apiKey, couriers: b.couriers, origin: pick.warehouse, destination: dest, items, fetch: f })); }
          catch { warnings.push('courier_rates_unavailable'); }
        }
      }
    }
    return { items, subtotal, dest, warehouse: pick.warehouse, distanceKm: pick.distanceKm, options: opts, warnings };
  }
  async function paymentMethods(t) {
    const want = (t.settings || {}).payments || ['manual'], out = [];
    for (const p of want) {
      if (p === 'manual') out.push('manual');
      else { const k = await secretOf(t.id, p); if (p === 'midtrans' ? k?.serverKey : k?.clientId && k?.secretKey) out.push(p); }
    }
    return out;
  }

  // ── order state changes (each guarded by the current status, so webhooks can repeat safely) ──
  async function markPaid(order, payPatch) {
    const up = await db.update('orders', { id: order.id, status: 'pending_payment' }, { status: 'paid', payment: { ...order.payment, ...payPatch, status: 'paid', paid_at: now().toISOString() } });
    if (up.length) { await db.rpc('commit_stock', { p_tenant: order.tenant_id, p_warehouse: order.warehouse_id, p_items: lines(order) }); return 'paid'; }
    if (order.status === 'expired' || order.status === 'cancelled') {  // money arrived after we released the stock
      let restocked = true;
      try { await db.rpc('reserve_stock', { p_tenant: order.tenant_id, p_warehouse: order.warehouse_id, p_items: lines(order) }); } catch { restocked = false; }
      const up2 = await db.update('orders', { id: order.id, status: order.status }, restocked
        ? { status: 'paid', payment: { ...order.payment, ...payPatch, status: 'paid', paid_at: now().toISOString(), late: true } }
        : { payment: { ...order.payment, ...payPatch, status: 'paid', paid_at: now().toISOString(), attention: 'paid_after_expiry_no_stock' } });
      if (restocked && up2.length) await db.rpc('commit_stock', { p_tenant: order.tenant_id, p_warehouse: order.warehouse_id, p_items: lines(order) });
      else if (restocked) await db.rpc('release_stock', { p_tenant: order.tenant_id, p_warehouse: order.warehouse_id, p_items: lines(order) });
      return restocked ? 'paid_late' : 'needs_refund';
    }
    return 'unchanged';
  }
  async function closeUnpaid(order, status, payPatch = {}) {
    const up = await db.update('orders', { id: order.id, status: 'pending_payment' }, { status, payment: { ...order.payment, ...payPatch, status: status === 'expired' ? 'expired' : 'failed' } });
    if (up.length) await db.rpc('release_stock', { p_tenant: order.tenant_id, p_warehouse: order.warehouse_id, p_items: lines(order) });
    return up.length > 0;
  }
  const lines = o => o.items.map(i => ({ variant_id: i.variant_id, qty: i.qty }));
  const publicOrder = o => ({ no: o.no, status: o.status, items: o.items.map(({ label, price, qty }) => ({ label, price, qty })), subtotal: o.subtotal, shipping_fee: o.shipping_fee, total: o.total,
    shipping: { label: o.shipping.label, eta: o.shipping.eta, waybill: o.shipping.booking?.waybill || null }, payment: { provider: o.payment.provider, status: o.payment.status, url: o.status === 'pending_payment' ? o.payment.url : undefined }, expires_at: o.expires_at, created_at: o.created_at });

  // ── routes ──
  const R = [];
  const on = (method, pattern, fn) => R.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

  // public storefront
  on('GET', '/api/store', async c => {
    const t = shop(c), ts = await secretOf(t.id, 'turnstile'), s = t.settings || {};
    return { store: { slug: t.slug, name: t.name, about: s.about || '', whatsapp: s.whatsapp || '' }, theme: theme(t), turnstile_site_key: ts?.siteKey || null,
             pickup: !!s.pickup, payments: await paymentMethods(t), manual: (s.payments || ['manual']).includes('manual') ? s.manual || null : null, midtrans_client_key: (await secretOf(t.id, 'midtrans'))?.clientKey || null };
  });
  on('GET', '/api/menu', async c => {
    const t = shop(c);
    const [products, variants, whs, stock] = await Promise.all([db.select('products', { tenant_id: t.id, active: true }, { order: 'sort' }), db.select('variants', { tenant_id: t.id, active: true }),
      db.select('warehouses', { tenant_id: t.id, active: true }), db.select('stock', { tenant_id: t.id })]);
    const av = availability(whs, stock);
    return { products: products.map(p => ({ id: p.id, name: p.name, description: p.description, image: p.image, category: p.category,
      variants: variants.filter(v => v.product_id === p.id).map(v => ({ id: v.id, name: v.name, price: Number(v.price), available: Math.min(av[v.id] || 0, 99) })) })).filter(p => p.variants.length) };
  });
  on('POST', '/api/quote', async c => {
    const t = shop(c), b = c.body;
    const p = await plan(t, b.items, b.destination, b.pickup === true, b.pickup_warehouse_id);
    return { subtotal: p.subtotal, warehouse: { id: p.warehouse.id, name: p.warehouse.name }, distance_km: p.distanceKm == null ? null : Math.round(p.distanceKm * 10) / 10, options: p.options, warnings: p.warnings };
  });
  on('POST', '/api/checkout', async c => {
    const t = shop(c), b = c.body;
    await turnstile(c, b.turnstile, t.id);
    const cust = isObj(b.customer) ? b.customer : {};
    const customer = { name: str(cust.name, 80), phone: digits(cust.phone).slice(0, 16), email: str(cust.email, 120).toLowerCase() };
    if (!customer.name || customer.phone.length < 8) throw E(400, 'bad_customer', 'Name and a valid phone number are required');
    if (customer.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(customer.email)) throw E(400, 'bad_customer', 'Invalid email');
    const pickup = b.shipping_id === 'pickup';
    const p = await plan(t, b.items, b.destination, pickup, b.pickup_warehouse_id);
    const ship = p.options.find(o => o.id === b.shipping_id);
    if (!ship) throw E(409, 'shipping_changed', 'Delivery options changed, please choose again');
    const methods = await paymentMethods(t);
    if (!methods.includes(b.payment)) throw E(400, 'bad_payment', 'Choose a payment method');
    try { await db.rpc('reserve_stock', { p_tenant: t.id, p_warehouse: p.warehouse.id, p_items: p.items.map(i => ({ variant_id: i.variant_id, qty: i.qty })) }); }
    catch (e) { if (e.code === 'out_of_stock') throw E(409, 'out_of_stock', 'Sorry, part of your order just sold out'); throw e; }
    const payMinutes = (t.settings || {}).pay_minutes || 60;
    const base = { tenant_id: t.id, status: 'pending_payment', customer, destination: p.dest, items: p.items, warehouse_id: p.warehouse.id, shipping: ship,
      payment: { provider: b.payment, status: 'pending' }, subtotal: p.subtotal, shipping_fee: ship.fee, total: p.subtotal + ship.fee,
      expires_at: new Date(now().getTime() + payMinutes * 60000).toISOString() };
    let order;
    for (let i = 0; !order; i++) {
      const d = now(), no = 'SO' + String(d.getUTCFullYear()).slice(2) + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0') + rid(3).toUpperCase();
      try { order = await db.insert('orders', { ...base, no }); } catch (e) { if (e.code !== 'duplicate' || i > 4) { await db.rpc('release_stock', { p_tenant: t.id, p_warehouse: p.warehouse.id, p_items: lines(base) }); throw e; } }
    }
    if (b.payment !== 'manual') {
      const keys = await secretOf(t.id, b.payment);
      const finishUrl = BASE_URL ? `${BASE_URL}/order/${order.no}?store=${t.slug}` : undefined;
      const args = { keys, order: { ref: order.no, total: order.total, items: order.items, shipping_fee: order.shipping_fee, customer, payMinutes }, finishUrl, fetch: f, now: now() };
      try {
        const r = b.payment === 'midtrans' ? await X.midtransCreate(args) : await X.dokuCreate({ ...args, notifyUrl: BASE_URL ? `${BASE_URL}/api/webhook/doku/${t.slug}` : undefined });
        order.payment = { ...order.payment, url: r.url, token: r.token || null };
        await db.update('orders', { id: order.id }, { payment: order.payment });
      } catch (e) {
        await closeUnpaid(order, 'cancelled', { error: 'gateway_unavailable' });
        throw E(502, 'payment_unavailable', 'Payment is unavailable right now, please try again');
      }
    }
    return { order: publicOrder(order), manual: b.payment === 'manual' ? (t.settings || {}).manual || null : null };
  });
  on('GET', '/api/order', async c => {
    const t = shop(c), no = str(c.url.searchParams.get('no'), 30).toUpperCase(), phone = digits(c.url.searchParams.get('phone'));
    if (!rlHit('find:' + c.ip, 20, 600000)) throw E(429, 'slow_down', 'Too many tries, wait a few minutes');
    const o = no && phone.length >= 8 ? await db.one('orders', { tenant_id: t.id, no }) : null;
    if (!o || o.customer.phone.slice(-9) !== phone.slice(-9)) throw E(404, 'not_found', 'Order not found');
    return { order: publicOrder(o) };
  });

  // payment & courier webhooks (each verified with the tenant's own keys)
  async function logEvent(t, provider, order_no, status, raw) { try { await db.insert('payment_events', { tenant_id: t.id, provider, order_no, status, raw }); } catch {} }
  on('POST', '/api/webhook/midtrans/:slug', async c => {
    const t = await tenantBySlug(c.params.slug), keys = t && await secretOf(t.id, 'midtrans');
    if (!keys || !X.midtransVerify(c.body, keys.serverKey)) throw E(401, 'bad_signature');
    const o = await db.one('orders', { tenant_id: t.id, no: String(c.body.order_id) });
    const st = X.midtransStatus(c.body);
    await logEvent(t, 'midtrans', c.body.order_id, c.body.transaction_status, c.body);
    if (!o) return { ok: true, note: 'unknown order' };
    if (Math.round(Number(c.body.gross_amount)) !== Number(o.total)) return { ok: true, note: 'amount mismatch – ignored' };
    const r = st === 'paid' ? await markPaid(o, { ref: c.body.transaction_id, method: c.body.payment_type }) : st === 'failed' ? await closeUnpaid(o, 'cancelled') : 'pending';
    return { ok: true, result: r };
  });
  on('POST', '/api/webhook/doku/:slug', async c => {
    const t = await tenantBySlug(c.params.slug), keys = t && await secretOf(t.id, 'doku');
    if (!keys || !X.dokuVerify({ headers: c.req.headers, rawBody: c.raw, keys, target: c.url.pathname })) throw E(401, 'bad_signature');
    const no = String(c.body?.order?.invoice_number || ''), o = no && await db.one('orders', { tenant_id: t.id, no });
    const st = X.dokuStatus(c.body);
    await logEvent(t, 'doku', no, c.body?.transaction?.status, c.body);
    if (!o) return { ok: true, note: 'unknown order' };
    if (Math.round(Number(c.body.order.amount)) !== Number(o.total)) return { ok: true, note: 'amount mismatch – ignored' };
    const r = st === 'paid' ? await markPaid(o, { ref: c.body?.transaction?.original_request_id || null, method: c.body?.channel?.id || null }) : st === 'failed' ? await closeUnpaid(o, 'cancelled') : 'pending';
    return { ok: true, result: r };
  });
  on('POST', '/api/webhook/biteship/:slug/:token', async c => {
    const t = await tenantBySlug(c.params.slug), keys = t && await secretOf(t.id, 'biteship');
    if (!keys?.webhookToken || !safeEq(keys.webhookToken, c.params.token)) throw E(401, 'bad_token');
    const id = String(c.body?.order_id || ''); if (!id) return { ok: true };
    const recent = await db.select('orders', { tenant_id: t.id, status: { in: ['paid', 'preparing', 'shipped'] } }, { order: 'created_at', desc: true, limit: 1000 });
    const o = recent.find(x => x.shipping?.booking?.id === id); if (!o) return { ok: true, note: 'unknown shipment' };
    const s = String(c.body.status || '');
    const status = s === 'delivered' ? 'delivered' : ['picked', 'dropping_off', 'on_hold'].includes(s) ? 'shipped' : o.status;
    await db.update('orders', { id: o.id }, { status, shipping: { ...o.shipping, booking: { ...o.shipping.booking, status: s, waybill: c.body.courier_waybill_id || o.shipping.booking.waybill } } });
    return { ok: true };
  });

  // sign-up, login, platform admin
  on('POST', '/api/signup', async c => {
    const b = c.body;
    await turnstile(c, b.turnstile, null);
    if (!rlHit('signup:' + c.ip, 5, 3600000)) throw E(429, 'slow_down', 'Too many sign-ups, try again later');
    const slug = str(b.slug, 32).toLowerCase(), name = str(b.store_name, 80), email = str(b.email, 120).toLowerCase(), pw = String(b.password || '');
    if (!SLUG.test(slug) || RESERVED_SLUGS.has(slug)) throw E(400, 'bad_slug', 'Store address: 3–32 letters, numbers or dashes');
    if (!name) throw E(400, 'bad_name', 'Store name is required');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw E(400, 'bad_email', 'Valid email is required');
    if (pw.length < 10) throw E(400, 'weak_password', 'Password must be 10+ characters');
    let t;
    try { t = await db.insert('tenants', { slug, name, status: 'pending', theme: {}, settings: { payments: ['manual'], pickup: true, pay_minutes: 60 } }); }
    catch (e) { if (e.code === 'duplicate') throw E(409, 'slug_taken', 'That store address is taken'); throw e; }
    const user = await db.insert('users', { tenant_id: t.id, email, name: str(b.name, 80), role: 'owner', cred: await mkCred(pw) });
    const s = issue(user);
    return { status: 201, body: { store: { slug, name, status: 'pending' }, token: s.token }, cookies: [s.cookie] };
  });
  on('POST', '/api/login', async c => {
    const email = str(c.body.email, 120).toLowerCase(), key = 'login:' + c.ip + ':' + email;
    if (!rlHit(key, 8, 900000)) throw E(429, 'slow_down', 'Too many tries, wait 15 minutes');
    const user = await db.one('users', { tenant_id: c.tenant ? c.tenant.id : null, email });
    if (!(await checkPw(user?.cred, c.body.password)) || (!c.tenant && user.role !== 'super')) throw E(401, 'bad_login', 'Wrong email or password');
    const s = issue(user); rl.delete(key);
    return { body: { role: user.role, token: s.token, store: c.tenant ? { slug: c.tenant.slug, status: c.tenant.status } : null }, cookies: [s.cookie] };
  });
  on('POST', '/api/logout', async () => ({ body: { ok: true }, cookies: ['so_sess=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'] }));
  on('GET', '/api/me', async c => (c.sess ? { role: c.sess.role, tenant_id: c.sess.tid, store: c.tenant && c.sess.tid === c.tenant.id ? { slug: c.tenant.slug, name: c.tenant.name, status: c.tenant.status } : null } : { role: null }));
  on('POST', '/api/super/setup', async c => {
    if (!env.SUPER_SETUP_KEY || env.SUPER_SETUP_KEY.length < 12 || !safeEq(String(c.body.key || ''), env.SUPER_SETUP_KEY)) throw E(403, 'bad_key');
    if ((await db.select('users', { role: 'super' }, { limit: 1 })).length) throw E(409, 'already_setup', 'Super-admin already exists');
    const email = str(c.body.email, 120).toLowerCase(); if (String(c.body.password || '').length < 12) throw E(400, 'weak_password', '12+ characters');
    await db.insert('users', { tenant_id: null, email, role: 'super', cred: await mkCred(c.body.password) });
    return { ok: true };
  });
  on('GET', '/api/super/tenants', async c => { superOf(c); return { tenants: (await db.select('tenants', {}, { order: 'created_at', desc: true })).map(({ id, slug, name, status, created_at }) => ({ id, slug, name, status, created_at })) }; });
  on('POST', '/api/super/tenants/:id/:action', async c => {
    superOf(c);
    const status = { approve: 'active', suspend: 'suspended' }[c.params.action]; if (!status) throw E(404, 'not_found');
    const up = await db.update('tenants', { id: c.params.id }, { status }); if (!up.length) throw E(404, 'not_found');
    return { ok: true, status };
  });
  on('POST', '/api/super/tenants/:id/domain', async c => {
    superOf(c); const host = str(c.body.host, 200).toLowerCase();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) throw E(400, 'bad_host');
    await db.upsert('tenant_domains', { host, tenant_id: c.params.id }); return { ok: true };
  });

  // store back office
  on('GET', '/api/admin/store', async c => { staffOf(c); const t = c.tenant; return { slug: t.slug, name: t.name, status: t.status, theme: theme(t), settings: t.settings || {}, fonts: FONTS }; });
  on('PUT', '/api/admin/theme', async c => { staffOf(c, ['owner']); const th = { ...(c.tenant.theme || {}), ...cleanTheme(c.body) }; await db.update('tenants', { id: c.tenant.id }, { theme: th }); return { theme: { ...DEFAULT_THEME, ...th } }; });
  on('PUT', '/api/admin/settings', async c => {
    staffOf(c, ['owner']); const s = { ...(c.tenant.settings || {}), ...cleanSettings(c.body) };
    if ('name' in c.body) { const n = str(c.body.name, 80); if (n) await db.update('tenants', { id: c.tenant.id }, { name: n }); }
    await db.update('tenants', { id: c.tenant.id }, { settings: s }); return { settings: s };
  });
  on('GET', '/api/admin/secrets', async c => {
    staffOf(c, ['owner']); const out = {};
    for (const [p, fields] of Object.entries(PROVIDERS)) {
      const k = await secretOf(c.tenant.id, p);
      out[p] = { configured: !!k, fields: Object.fromEntries(Object.entries(fields).map(([n, kind]) => [n, !k ? null : kind === 'secret' ? mask(k[n]) : k[n] ?? null])) };
    }
    if (BASE_URL) {
      out.midtrans.notify_url = `${BASE_URL}/api/webhook/midtrans/${c.tenant.slug}`;
      out.doku.notify_url = `${BASE_URL}/api/webhook/doku/${c.tenant.slug}`;
      const b = await secretOf(c.tenant.id, 'biteship'); if (b?.webhookToken) out.biteship.webhook_url = `${BASE_URL}/api/webhook/biteship/${c.tenant.slug}/${b.webhookToken}`;
    }
    return out;
  });
  on('PUT', '/api/admin/secrets/:provider', async c => {
    staffOf(c, ['owner']); const fields = PROVIDERS[c.params.provider]; if (!fields) throw E(404, 'not_found');
    const cur = (await secretOf(c.tenant.id, c.params.provider)) || {};
    for (const [n, kind] of Object.entries(fields)) if (n in c.body) cur[n] = kind === 'bool' ? c.body[n] === true : str(c.body[n], 500);
    if (c.params.provider === 'biteship' && !cur.webhookToken) cur.webhookToken = rid(16);
    await db.upsert('tenant_secrets', { tenant_id: c.tenant.id, provider: c.params.provider, enc: encrypt(MASTER, cur), updated_at: now().toISOString() });
    return { ok: true };
  });
  on('DELETE', '/api/admin/secrets/:provider', async c => { staffOf(c, ['owner']); await db.delete('tenant_secrets', { tenant_id: c.tenant.id, provider: c.params.provider }); return { ok: true }; });
  on('POST', '/api/admin/staff', async c => {
    staffOf(c, ['owner']); const email = str(c.body.email, 120).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || String(c.body.password || '').length < 10) throw E(400, 'bad_staff', 'Valid email and 10+ character password');
    try { await db.insert('users', { tenant_id: c.tenant.id, email, name: str(c.body.name, 80), role: 'staff', cred: await mkCred(c.body.password) }); }
    catch (e) { if (e.code === 'duplicate') throw E(409, 'exists', 'That email already has an account'); throw e; }
    return { ok: true };
  });

  // generic tenant-scoped CRUD for warehouses, products, variants, courier zones
  for (const [path, table] of [['warehouses', 'warehouses'], ['products', 'products'], ['variants', 'variants'], ['zones', 'courier_zones']]) {
    const writer = table === 'warehouses' || table === 'courier_zones' ? ['owner'] : ['owner', 'staff'];
    on('GET', `/api/admin/${path}`, async c => { staffOf(c); return { rows: await db.select(table, { tenant_id: c.tenant.id }) }; });
    on('POST', `/api/admin/${path}`, async c => {
      staffOf(c, writer); const row = pickFields(table, c.body, false);
      await ownRefs(c.tenant.id, row);
      return { row: await db.insert(table, { ...row, tenant_id: c.tenant.id }) };
    });
    on('PATCH', `/api/admin/${path}/:id`, async c => {
      staffOf(c, writer); const row = pickFields(table, c.body, true); await ownRefs(c.tenant.id, row);
      const up = await db.update(table, { id: c.params.id, tenant_id: c.tenant.id }, row); if (!up.length) throw E(404, 'not_found'); return { row: up[0] };
    });
    on('DELETE', `/api/admin/${path}/:id`, async c => {
      staffOf(c, writer); if (!(await db.delete(table, { id: c.params.id, tenant_id: c.tenant.id }))) throw E(404, 'not_found'); return { ok: true };
    });
  }
  // a row may only point at the same tenant's product / warehouse
  async function ownRefs(tid, row) {
    if (row.product_id && !(await db.one('products', { id: row.product_id, tenant_id: tid }))) throw E(400, 'bad_product');
    if (row.warehouse_id && !(await db.one('warehouses', { id: row.warehouse_id, tenant_id: tid }))) throw E(400, 'bad_warehouse');
  }
  on('GET', '/api/admin/stock', async c => { staffOf(c); return { rows: await db.select('stock', { tenant_id: c.tenant.id }) }; });
  on('PUT', '/api/admin/stock', async c => {
    staffOf(c); const qty = num(c.body.qty);
    if (qty == null || qty < 0 || !Number.isInteger(qty)) throw E(400, 'bad_qty');
    const [w, v] = await Promise.all([db.one('warehouses', { id: str(c.body.warehouse_id, 64), tenant_id: c.tenant.id }), db.one('variants', { id: str(c.body.variant_id, 64), tenant_id: c.tenant.id })]);
    if (!w || !v) throw E(400, 'bad_ref');
    const cur = await db.one('stock', { warehouse_id: w.id, variant_id: v.id });
    if (cur && qty < cur.reserved) throw E(409, 'below_reserved', `${cur.reserved} units are held by unpaid orders`);
    return { row: await db.upsert('stock', { tenant_id: c.tenant.id, warehouse_id: w.id, variant_id: v.id, qty, reserved: cur?.reserved || 0 }) };
  });
  on('GET', '/api/admin/orders', async c => {
    staffOf(c); const st = c.url.searchParams.get('status');
    return { rows: await db.select('orders', { tenant_id: c.tenant.id, ...(st ? { status: st } : {}) }, { order: 'created_at', desc: true, limit: 200 }) };
  });
  on('PATCH', '/api/admin/orders/:no', async c => {
    staffOf(c); const o = await db.one('orders', { tenant_id: c.tenant.id, no: c.params.no }); if (!o) throw E(404, 'not_found');
    const to = str(c.body.status, 20);
    if (!(ORDER_FLOW[o.status] || []).includes(to)) throw E(409, 'bad_transition', `Can't go from ${o.status} to ${to}`);
    if (to === 'cancelled' && o.status === 'pending_payment') { await closeUnpaid(o, 'cancelled'); return { ok: true }; }
    // a paid order's stock has already left the warehouse; if the goods come back, add them with PUT /api/admin/stock
    const up = await db.update('orders', { id: o.id, status: o.status }, { status: to });
    return { ok: !!up.length };
  });
  on('POST', '/api/admin/orders/:no/confirm-payment', async c => {
    staffOf(c); const o = await db.one('orders', { tenant_id: c.tenant.id, no: c.params.no }); if (!o) throw E(404, 'not_found');
    if (o.payment.provider !== 'manual') throw E(409, 'not_manual', 'This order is paid through a gateway');
    return { result: await markPaid(o, { confirmed_by: c.sess.uid }) };
  });
  on('POST', '/api/admin/orders/:no/book', async c => {
    staffOf(c); const o = await db.one('orders', { tenant_id: c.tenant.id, no: c.params.no }); if (!o) throw E(404, 'not_found');
    if (o.shipping.provider !== 'biteship') throw E(409, 'not_courier', 'This order uses pickup or the store courier');
    if (!['paid', 'preparing'].includes(o.status)) throw E(409, 'not_paid', 'Only paid orders can be booked');
    if (o.shipping.booking?.id) return { booking: o.shipping.booking };
    const [keys, w] = await Promise.all([secretOf(c.tenant.id, 'biteship'), db.one('warehouses', { id: o.warehouse_id, tenant_id: c.tenant.id })]);
    if (!keys?.apiKey) throw E(400, 'no_biteship', 'Add your Biteship key first');
    const booking = await X.biteshipBook({ key: keys.apiKey, order: o, warehouse: w, fetch: f });
    await db.update('orders', { id: o.id }, { status: 'preparing', shipping: { ...o.shipping, booking } });
    return { booking };
  });

  // scheduled clean-up: unpaid orders past their deadline give their stock back
  on('POST', '/api/cron/sweep', async c => {
    if (!env.CRON_SECRET || !safeEq(c.req.headers.get('x-cron-secret') || '', env.CRON_SECRET)) throw E(401, 'bad_secret');
    return { expired: await sweep() };
  });
  async function sweep() {
    const due = await db.select('orders', { status: 'pending_payment', expires_at: { lt: now().toISOString() } }, { limit: 500 });
    let n = 0; for (const o of due) if (await closeUnpaid(o, 'expired')) n++;
    return n;
  }

  // ── request handler ──
  async function handle(req) {
    const url = new URL(req.url), origin = req.headers.get('origin');
    const cors = origin && ORIGINS.has(origin) ? { 'access-control-allow-origin': origin, vary: 'origin' } : {};
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE', 'access-control-allow-headers': 'content-type,authorization,x-tenant', 'access-control-max-age': '86400' } });
    const send = (status, body, cookies = []) => {
      const h = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...cors });
      cookies.forEach(k => h.append('set-cookie', k));
      return new Response(JSON.stringify(body), { status, headers: h });
    };
    try {
      let route, params;
      for (const r of R) { if (r.method !== req.method) continue; const m = r.re.exec(url.pathname); if (m) { route = r; params = m.groups || {}; break; } }
      if (!route) throw E(404, 'not_found', 'Not found');
      let raw = '', body = {};
      if (!['GET', 'DELETE'].includes(req.method)) {
        raw = await req.text(); if (raw.length > 200_000) throw E(413, 'too_large');
        if (raw) { try { body = JSON.parse(raw); } catch { throw E(400, 'bad_json'); } }
        if (!isObj(body)) throw E(400, 'bad_json');
      }
      const c = { req, url, params, raw, body, sess: sessionOf(req), ip: req.headers.get('x-nf-client-connection-ip') || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'local' };
      c.tenant = url.pathname.startsWith('/api/webhook/') || url.pathname.startsWith('/api/super/') || url.pathname === '/api/cron/sweep' ? null : await resolveTenant(req, url);
      const out = await route.fn(c);
      if (out && 'body' in out && ('cookies' in out || 'status' in out)) return send(out.status || 200, out.body, out.cookies);
      return send(200, out);
    } catch (e) {
      if (e.status) return send(e.status, { error: e.code, message: e.message });
      console.error(e);
      return send(500, { error: 'server_error', message: 'Something went wrong' });
    }
  }
  return { handle, sweep };
}
