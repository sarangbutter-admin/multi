// Sarang Order – multi-tenant API. One handler for every store; the tenant comes from the domain or the X-Tenant header.
import { rid, mkCred, checkPw, signSession, readSession, encrypt, decrypt, mask, safeEq } from './crypto.mjs';
import * as X from './integrations.mjs';
import * as TH from './theme.mjs';
import BUILTIN_FILES from './builtin-themes.mjs';
import { buildItems, pickWarehouse, availability, storeCourierOption, haversineKm, tierDiscount, couponProblem, couponDiscount } from './fulfil.mjs';

const E = (status, code, message) => Object.assign(new Error(message || code), { status, code });
const isObj = x => x && typeof x === 'object' && !Array.isArray(x);
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = v => (typeof v === 'number' && isFinite(v) ? v : v === '' || v == null ? null : isFinite(Number(v)) ? Number(v) : null);
const digits = p => String(p || '').replace(/\D/g, '');
const RESERVED_SLUGS = new Set(['www', 'api', 'app', 'admin', 'super', 'mail', 'static', 'cdn', 'help', 'status']);
const SLUG = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
const FONTS = TH.FONTS;
const PROVIDERS = {
  midtrans: { serverKey: 'secret', clientKey: 'public', production: 'bool' },
  doku: { clientId: 'public', secretKey: 'secret', production: 'bool' },
  biteship: { apiKey: 'secret', couriers: 'public' },
  turnstile: { siteKey: 'public', secretKey: 'secret' }
};
const ORDER_FLOW = { paid: ['preparing', 'cancelled'], preparing: ['shipped', 'cancelled'], shipped: ['delivered'], pending_payment: ['cancelled'] };

// core look values every storefront needs; a theme's own defaults and the store's saved values go on top
export const DEFAULT_THEME = { primary: '#1F6F4A', accent: '#FFD23F', background: '#F3F7F2', surface: '#FFFFFF', text: '#13241B', radius: 14, font: 'Plus Jakarta Sans', logo: '' };
// built-in themes (themes/ folder, bundled by scripts/bundle-themes.mjs), checked the same way as uploads
const BUILT = Object.fromEntries(Object.entries(BUILTIN_FILES).map(([k, f]) => [k, TH.checkPackage(Object.fromEntries(Object.entries(f).map(([n, b]) => [n, Buffer.from(b, 'base64')])))]));
export const DEFAULT_THEME_REF = 'market';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const THEME_COLS = 'id,tenant_id,slug,name,version,manifest,preview,hash,status,review_note,created_at,updated_at';

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
  if ('listed' in s) out.listed = s.listed !== false;
  if ('about' in s) out.about = str(s.about, 1000);
  if ('whatsapp' in s) out.whatsapp = digits(s.whatsapp).slice(0, 16);
  if ('complaint_hours' in s) { const h = num(s.complaint_hours); if (h == null || h < 1 || h > 720) throw E(400, 'bad_settings', 'complaint_hours 1–720'); out.complaint_hours = Math.round(h); }
  if ('tiers' in s) {
    if (!isObj(s.tiers)) throw E(400, 'bad_settings', 'tiers');
    out.tiers = {};
    for (const k of ['regular', 'b2b']) {
      const t = s.tiers[k]; if (!isObj(t)) continue;
      const pct = num(t.pct), qty = num(t.qty), amt = num(t.amt);
      if (pct == null || pct < 0 || pct > 50) throw E(400, 'bad_settings', 'Discount must be 0–50%');
      if (qty == null || qty < 1 || !Number.isInteger(qty)) throw E(400, 'bad_settings', 'Minimum items must be a whole number, 1 or more');
      if (amt == null || amt < 0) throw E(400, 'bad_settings', 'Minimum spend must be 0 or more');
      out.tiers[k] = { pct, qty, amt: Math.round(amt) };
    }
  }
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
PICK.coupons = {
  code: v => { const c = String(v || '').trim().toUpperCase(); if (!/^[A-Z0-9]{1,16}$/.test(c)) throw E(400, 'bad_code', 'Coupon codes use letters A–Z and numbers 0–9, up to 16 characters'); return c; },
  type: v => { if (!['pct', 'amt'].includes(v)) throw E(400, 'bad_coupon', 'Choose percent or fixed amount'); return v; },
  value: v => { const n = num(v); if (n == null || n <= 0 || !Number.isInteger(n)) throw E(400, 'bad_coupon', 'Discount must be a whole number above 0'); return n; },
  min_purchase: v => Math.max(Math.round(num(v) || 0), 0), max_uses: v => Math.max(Math.round(num(v) || 0), 0),
  expires_at: v => { if (!v) return null; const d = new Date(v); if (isNaN(d)) throw E(400, 'bad_coupon', 'Invalid expiry date'); return d.toISOString(); },
  active: v => v !== false
};
const REQUIRED = { warehouses: ['name'], products: ['name'], variants: ['product_id', 'name', 'price'], courier_zones: ['name', 'max_km', 'fee'], coupons: ['code', 'type', 'value'] };
const COMPLAINT_REASONS = ['Damaged item', 'Wrong item', 'Missing item', 'Quality problem', 'Other'];
const okImg = s => typeof s === 'string' && s.length <= 260000 && /^data:image\/(jpeg|webp);base64,[A-Za-z0-9+\/=]+$/.test(s);
const okLogin = u => /^[a-z0-9_.]{3,20}$/.test(u);
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

  // ── themes ──
  async function themeMeta(ref) {
    if (BUILT[ref]) { const p = BUILT[ref]; return { ref, builtin: true, manifest: p.manifest, hash: p.hash, preview: p.preview, status: 'public', tenant_id: null, review_note: '', updated_at: null }; }
    if (!UUID.test(ref || '')) return null;
    const r = (await db.select('themes', { id: ref }, { limit: 1, cols: THEME_COLS }))[0];
    return r ? { ref: r.id, builtin: false, ...r } : null;
  }
  async function themePkg(ref) {
    if (BUILT[ref]) return BUILT[ref];
    if (!UUID.test(ref || '')) return null;
    const r = await db.one('themes', { id: ref });
    return r && { manifest: r.manifest, css: r.css, templates: r.templates, assets: r.assets || {}, preview: r.preview, hash: r.hash };
  }
  const activeMeta = async t => (await themeMeta(t.theme_ref || DEFAULT_THEME_REF)) || themeMeta(DEFAULT_THEME_REF);
  const themeValues = (meta, t) => ({ ...DEFAULT_THEME, ...TH.defaults(TH.fullSchema(meta.manifest.settings)), ...(t.theme || {}) });
  const canUseTheme = (m, t) => m && (m.builtin || m.status === 'public' || (t && m.tenant_id === t.id));
  const themeCard = (m, t, stores = {}) => ({ ref: m.ref, name: m.manifest.name, version: m.manifest.version, author: m.manifest.author, description: m.manifest.description,
    preview: m.preview, builtin: m.builtin, status: m.status, mine: !!t && m.tenant_id === t.id, review_note: m.review_note || '', store: m.tenant_id ? stores[m.tenant_id] || null : null, updated_at: m.updated_at });
  async function storeNames(ids) { const u = [...new Set(ids.filter(Boolean))]; return u.length ? Object.fromEntries((await db.select('tenants', { id: { in: u } })).map(t => [t.id, t.name])) : {}; }
  // the directory and old callers only need plain colour values (asset: images can't be shown outside the theme)
  async function lookOf(t) { const v = themeValues(await activeMeta(t), t); if (String(v.logo).startsWith('asset:')) v.logo = ''; return v; }

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
  // read-only storefront routes also open for the store's own staff before approval, so they can preview their look
  const shopView = c => (c.tenant && c.tenant.status === 'pending' && c.sess && c.sess.tid === c.tenant.id && ['owner', 'staff'].includes(c.sess.role) ? c.tenant : shop(c));
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
    return { items, subtotal, qty: items.reduce((n, i) => n + i.qty, 0), dest, warehouse: pick.warehouse, distanceKm: pick.distanceKm, options: opts, warnings };
  }
  async function paymentMethods(t) {
    const want = (t.settings || {}).payments || ['manual'], out = [];
    for (const p of want) {
      if (p === 'manual') out.push('manual');
      else { const k = await secretOf(t.id, p); if (p === 'midtrans' ? k?.serverKey : k?.clientId && k?.secretKey) out.push(p); }
    }
    return out;
  }

  // ── business accounts, tiers and coupons ──
  async function b2bOf(c, t) {
    if (c.sess?.role !== 'b2b' || c.sess.tid !== t.id) return null;
    const a = await db.one('b2b_accounts', { id: c.sess.uid, tenant_id: t.id });
    return a && a.active ? a : null;
  }
  async function pricing(t, c, p, code) {
    const b2b = await b2bOf(c, t), tier = b2b ? 'b2b' : 'regular';
    const td = tierDiscount((t.settings || {}).tiers, tier, p.subtotal, p.qty);
    const out = { b2b, tier, td, cd: 0, coupon: null, couponError: null };
    code = str(code, 40).toUpperCase();
    if (code) {
      const cp = /^[A-Z0-9]{1,16}$/.test(code) ? await db.one('coupons', { tenant_id: t.id, code }) : null;
      out.couponError = couponProblem(cp, p.subtotal, now());
      if (!out.couponError) { out.coupon = cp; out.cd = couponDiscount(cp, p.subtotal, td); }
    }
    return out;
  }
  // redemption counter: compare-and-swap so two buyers can't both take the last use
  async function redeemCoupon(cp) {
    for (let i = 0; i < 6; i++) {
      const cur = await db.one('coupons', { id: cp.id, tenant_id: cp.tenant_id });
      if (!cur || couponProblem({ ...cur, min_purchase: 0 }, 0, now())) throw E(400, 'coupon', 'This coupon has been fully redeemed.');
      if ((await db.update('coupons', { id: cp.id, used: cur.used }, { used: cur.used + 1 })).length) return;
    }
    throw E(409, 'busy', 'Please try again');
  }
  async function releaseCoupon(tenantId, code) {
    if (!code) return;
    for (let i = 0; i < 6; i++) {
      const cur = await db.one('coupons', { tenant_id: tenantId, code }); if (!cur || cur.used <= 0) return;
      if ((await db.update('coupons', { id: cur.id, used: cur.used }, { used: cur.used - 1 })).length) return;
    }
  }

  // ── order state changes (each guarded by the current status, so webhooks can repeat safely) ──
  async function markPaid(order, payPatch) {
    const up = await db.update('orders', { id: order.id, status: 'pending_payment' }, { status: 'paid', payment: { ...order.payment, ...payPatch, status: 'paid', paid_at: now().toISOString() } });
    if (up.length) { await db.rpc('commit_stock', { p_tenant: order.tenant_id, p_warehouse: order.warehouse_id, p_items: lines(order) }); return 'paid'; }
    if (order.status === 'expired' || order.status === 'cancelled') {  // money arrived after we released the stock
      let restocked = true;
      try { await db.rpc('reserve_stock', { p_tenant: order.tenant_id, p_warehouse: order.warehouse_id, p_items: lines(order) }); } catch { restocked = false; }
      if (restocked && order.coupon_code) { try { const cp = await db.one('coupons', { tenant_id: order.tenant_id, code: order.coupon_code }); if (cp) await redeemCoupon(cp); } catch {} }
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
    if (up.length) { await db.rpc('release_stock', { p_tenant: order.tenant_id, p_warehouse: order.warehouse_id, p_items: lines(order) }); await releaseCoupon(order.tenant_id, order.coupon_code); }
    return up.length > 0;
  }
  const lines = o => o.items.map(i => ({ variant_id: i.variant_id, qty: i.qty }));
  const publicOrder = o => ({ no: o.no, status: o.status, items: o.items.map(({ product_id, label, price, qty }) => ({ product_id, label, price, qty })), subtotal: o.subtotal, tier_discount: o.tier_discount || 0, coupon_code: o.coupon_code || null, coupon_discount: o.coupon_discount || 0, shipping_fee: o.shipping_fee, total: o.total,
    shipping: { label: o.shipping.label, eta: o.shipping.eta, waybill: o.shipping.booking?.waybill || null }, payment: { provider: o.payment.provider, status: o.payment.status, url: o.status === 'pending_payment' ? o.payment.url : undefined }, expires_at: o.expires_at, created_at: o.created_at });

  // ── routes ──
  const R = [];
  const on = (method, pattern, fn, { max = 200_000 } = {}) => R.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn, max });

  // public storefront
  on('GET', '/api/store', async c => {
    const t = shopView(c), ts = await secretOf(t.id, 'turnstile'), s = t.settings || {}, meta = await activeMeta(t);
    return { store: { slug: t.slug, name: t.name, about: s.about || '', whatsapp: s.whatsapp || '' }, theme: themeValues(meta, t), theme_saved: t.theme || {},
             theme_ref: meta.ref, theme_pkg: `/api/themes/${meta.ref}/package?h=${meta.hash}`, turnstile_site_key: ts?.siteKey || null,
             pickup: !!s.pickup, payments: await paymentMethods(t), manual: (s.payments || ['manual']).includes('manual') ? s.manual || null : null, midtrans_client_key: (await secretOf(t.id, 'midtrans'))?.clientKey || null };
  });
  // the shared app's store picker: live stores only, public look only
  on('GET', '/api/directory', async () => {
    const rows = await db.select('tenants', { status: 'active' }, { order: 'name' });
    return { stores: await Promise.all(rows.filter(t => (t.settings || {}).listed !== false).map(async t => { const th = await lookOf(t); return { slug: t.slug, name: t.name, about: (t.settings || {}).about || '', logo: th.logo, primary: th.primary, accent: th.accent, background: th.background }; })) };
  });
  // a theme's files for the storefront; the ?h= hash makes it cacheable forever
  on('GET', '/api/themes/:ref/package', async c => {
    const p = await themePkg(c.params.ref);
    if (!p) throw E(404, 'no_theme', 'Theme not found');
    const fresh = c.url.searchParams.get('h') === p.hash;
    return { body: TH.clientPackage(c.params.ref, p), headers: { 'cache-control': fresh ? 'public, max-age=31536000, immutable' : 'public, max-age=60' } };
  });
  on('GET', '/api/menu', async c => {
    const t = shopView(c);
    const [products, variants, whs, stock, revs] = await Promise.all([db.select('products', { tenant_id: t.id, active: true }, { order: 'sort' }), db.select('variants', { tenant_id: t.id, active: true }),
      db.select('warehouses', { tenant_id: t.id, active: true }), db.select('stock', { tenant_id: t.id }), db.select('reviews', { tenant_id: t.id })]);
    const av = availability(whs, stock), rating = {};
    for (const r of revs) { const x = (rating[r.product_id] ||= { sum: 0, count: 0 }); x.sum += r.stars; x.count++; }
    return { products: products.map(p => ({ id: p.id, name: p.name, description: p.description, image: p.image, category: p.category,
      rating: rating[p.id] ? { avg: Math.round(rating[p.id].sum / rating[p.id].count * 10) / 10, count: rating[p.id].count } : null,
      variants: variants.filter(v => v.product_id === p.id).map(v => ({ id: v.id, name: v.name, price: Number(v.price), available: Math.min(av[v.id] || 0, 99) })) })).filter(p => p.variants.length) };
  });
  on('POST', '/api/quote', async c => {
    const t = shop(c), b = c.body;
    const p = await plan(t, b.items, b.destination, b.pickup === true, b.pickup_warehouse_id);
    const pr = await pricing(t, c, p, b.coupon);
    return { pricing: { subtotal: p.subtotal, tier: pr.tier, tier_discount: pr.td, coupon: pr.coupon ? pr.coupon.code : null, coupon_discount: pr.cd, coupon_error: pr.couponError, business: pr.b2b ? pr.b2b.name : null }, subtotal: p.subtotal, warehouse: { id: p.warehouse.id, name: p.warehouse.name }, distance_km: p.distanceKm == null ? null : Math.round(p.distanceKm * 10) / 10, options: p.options, warnings: p.warnings };
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
    const pr = await pricing(t, c, p, b.coupon);
    if (str(b.coupon, 40) && pr.couponError) throw E(400, 'coupon', pr.couponError);
    try { await db.rpc('reserve_stock', { p_tenant: t.id, p_warehouse: p.warehouse.id, p_items: p.items.map(i => ({ variant_id: i.variant_id, qty: i.qty })) }); }
    catch (e) { if (e.code === 'out_of_stock') throw E(409, 'out_of_stock', 'Sorry, part of your order just sold out'); throw e; }
    if (pr.coupon) { try { await redeemCoupon(pr.coupon); } catch (e) { await db.rpc('release_stock', { p_tenant: t.id, p_warehouse: p.warehouse.id, p_items: p.items.map(i => ({ variant_id: i.variant_id, qty: i.qty })) }); throw e; } }
    const payMinutes = (t.settings || {}).pay_minutes || 60;
    const base = { tenant_id: t.id, status: 'pending_payment', customer, destination: p.dest, items: p.items, warehouse_id: p.warehouse.id, shipping: ship,
      payment: { provider: b.payment, status: 'pending' }, subtotal: p.subtotal, tier_discount: pr.td, coupon_code: pr.coupon ? pr.coupon.code : null, coupon_discount: pr.cd, b2b_id: pr.b2b ? pr.b2b.id : null,
      shipping_fee: ship.fee, total: p.subtotal - pr.td - pr.cd + ship.fee,
      expires_at: new Date(now().getTime() + payMinutes * 60000).toISOString() };
    let order;
    for (let i = 0; !order; i++) {
      const d = now(), no = 'SO' + String(d.getUTCFullYear()).slice(2) + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0') + rid(3).toUpperCase();
      try { order = await db.insert('orders', { ...base, no }); } catch (e) { if (e.code !== 'duplicate' || i > 4) { await db.rpc('release_stock', { p_tenant: t.id, p_warehouse: p.warehouse.id, p_items: lines(base) }); await releaseCoupon(t.id, base.coupon_code); throw e; } }
    }
    if (b.payment !== 'manual') {
      const keys = await secretOf(t.id, b.payment);
      const finishUrl = BASE_URL ? `${BASE_URL}/order/${order.no}?store=${t.slug}` : undefined;
      const discounted = order.tier_discount + order.coupon_discount > 0;
      const args = { keys, order: { ref: order.no, total: order.total, items: order.items, shipping_fee: order.shipping_fee, customer, payMinutes, ...(discounted ? { lines: [{ id: 'order', name: `Order ${order.no}`.slice(0, 50), price: order.total, quantity: 1 }] } : {}) }, finishUrl, fetch: f, now: now() };
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
  // an order is found by its number plus the phone it was placed with
  async function findOrder(c, t, no, phone) {
    no = str(no, 30).toUpperCase(); phone = digits(phone);
    if (!rlHit('find:' + c.ip, 30, 600000)) throw E(429, 'slow_down', 'Too many tries, wait a few minutes');
    const o = no && phone.length >= 8 ? await db.one('orders', { tenant_id: t.id, no }) : null;
    if (!o || o.customer.phone.slice(-9) !== phone.slice(-9)) throw E(404, 'not_found', 'Order not found');
    return o;
  }
  const complaintHours = t => (t.settings || {}).complaint_hours || 48;
  on('GET', '/api/order', async c => {
    const t = shop(c), o = await findOrder(c, t, c.url.searchParams.get('no'), c.url.searchParams.get('phone'));
    const out = publicOrder(o);
    if (o.status === 'delivered') {
      const [revs, cmp] = await Promise.all([db.select('reviews', { tenant_id: t.id, order_no: o.no }), db.one('complaints', { tenant_id: t.id, order_no: o.no })]);
      const until = new Date(new Date(o.delivered_at || o.created_at).getTime() + complaintHours(t) * 3600000);
      out.reviewed = revs.map(r => r.product_id);
      out.complaint = cmp ? { status: cmp.status, note: cmp.note || '' } : null;
      out.can_complain = !cmp && now() <= until; out.complain_until = until.toISOString();
    }
    return { order: out };
  });

  // reviews: one rating per item, after delivery
  on('GET', '/api/reviews', async c => {
    const t = shopView(c), rows = await db.select('reviews', { tenant_id: t.id }, { order: 'created_at', desc: true, limit: 60 });
    return { reviews: rows.map(r => ({ product_id: r.product_id, product: r.product_name, name: r.name.split(' ')[0], stars: r.stars, text: r.text, at: r.created_at })) };
  });
  on('POST', '/api/review', async c => {
    const t = shop(c), b = c.body, o = await findOrder(c, t, b.no, b.phone), stars = Math.floor(Number(b.stars));
    if (o.status !== 'delivered') throw E(409, 'not_delivered', 'You can rate your order after it is delivered');
    const it = o.items.find(i => i.product_id === b.product_id); if (!it) throw E(400, 'bad_item', 'Item not found in this order');
    if (!(stars >= 1 && stars <= 5)) throw E(400, 'bad_stars', 'Choose 1 to 5 stars');
    try { await db.insert('reviews', { tenant_id: t.id, order_no: o.no, product_id: it.product_id, product_name: it.label, name: o.customer.name, stars, text: str(b.text, 200) }); }
    catch (e) { if (e.code === 'duplicate') throw E(409, 'exists', 'You already rated this item'); throw e; }
    return { ok: true };
  });
  on('POST', '/api/complaint', async c => {
    const t = shop(c), b = c.body, o = await findOrder(c, t, b.no, b.phone);
    if (o.status !== 'delivered') throw E(409, 'not_delivered', 'You can report a problem after the order is delivered or picked up');
    if (now() > new Date(new Date(o.delivered_at || o.created_at).getTime() + complaintHours(t) * 3600000)) throw E(409, 'closed', 'Sorry, the complaint period has ended');
    const reason = COMPLAINT_REASONS.includes(b.reason) ? b.reason : 'Other', text = str(b.text, 400), imgs = Array.isArray(b.imgs) ? b.imgs.slice(0, 3) : [];
    if (text.length < 5) throw E(400, 'bad_text', 'Please describe the problem');
    if (!imgs.length || !imgs.every(okImg)) throw E(400, 'bad_img', 'Add 1 to 3 photos of the product');
    let cmp;
    try { cmp = await db.insert('complaints', { tenant_id: t.id, order_no: o.no, name: o.customer.name, phone: o.customer.phone, reason, item: str(b.item, 80), text, nimg: imgs.length }); }
    catch (e) { if (e.code === 'duplicate') throw E(409, 'exists', 'A complaint was already sent for this order'); throw e; }
    for (const [position, data] of imgs.entries()) await db.insert('complaint_images', { tenant_id: t.id, complaint_id: cmp.id, position, data });
    return { ok: true };
  }, { max: 900_000 });

  // business accounts sign in here to get the business tier
  on('POST', '/api/b2b/login', async c => {
    const t = shop(c), login = str(c.body.login, 40).toLowerCase(), key = 'b2b:' + c.ip + ':' + login;
    if (!rlHit(key, 8, 900000)) throw E(429, 'slow_down', 'Too many tries, wait 15 minutes');
    const a = okLogin(login) ? await db.one('b2b_accounts', { tenant_id: t.id, login }) : null;
    if (!(await checkPw(a?.cred, c.body.password)) || !a.active) throw E(401, 'bad_login', 'Wrong username or password');
    rl.delete(key); const s = issue({ id: a.id, tenant_id: t.id, role: 'b2b' });
    return { body: { token: s.token, account: { name: a.name } }, cookies: [s.cookie] };
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
    await db.update('orders', { id: o.id }, { status, ...(status === 'delivered' && o.status !== 'delivered' ? { delivered_at: now().toISOString() } : {}), shipping: { ...o.shipping, booking: { ...o.shipping.booking, status: s, waybill: c.body.courier_waybill_id || o.shipping.booking.waybill } } });
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
  on('GET', '/api/me', async c => (c.sess?.role === 'b2b' ? { role: 'b2b', business: c.tenant && c.sess.tid === c.tenant.id ? ((await b2bOf(c, c.tenant))?.name || null) : null } : c.sess ? { role: c.sess.role, tenant_id: c.sess.tid, store: c.tenant && c.sess.tid === c.tenant.id ? { slug: c.tenant.slug, name: c.tenant.name, status: c.tenant.status } : null } : { role: null }));
  on('POST', '/api/super/setup', async c => {
    if (!env.SUPER_SETUP_KEY || env.SUPER_SETUP_KEY.length < 12 || !safeEq(String(c.body.key || ''), env.SUPER_SETUP_KEY)) throw E(403, 'bad_key');
    if ((await db.select('users', { role: 'super' }, { limit: 1 })).length) throw E(409, 'already_setup', 'Super-admin already exists');
    const email = str(c.body.email, 120).toLowerCase(); if (String(c.body.password || '').length < 12) throw E(400, 'weak_password', '12+ characters');
    await db.insert('users', { tenant_id: null, email, role: 'super', cred: await mkCred(c.body.password) });
    return { ok: true };
  });
  on('GET', '/api/super/themes', async c => {
    superOf(c);
    const rows = await db.select('themes', { status: { in: ['review', 'public', 'rejected'] } }, { cols: THEME_COLS, order: 'updated_at', desc: true });
    const names = await storeNames(rows.map(r => r.tenant_id)), live = await db.select('tenants', { status: 'active' }, { order: 'name', limit: 1 });
    return { themes: rows.map(r => themeCard({ ref: r.id, builtin: false, ...r }, null, names)), preview_store: live[0]?.slug || null };
  });
  on('GET', '/api/super/themes/:id/download', async c => { superOf(c); if (!UUID.test(c.params.id)) throw E(404, 'no_theme'); return downloadTheme(c.params.id); });
  on('POST', '/api/super/themes/:id/:action', async c => {
    superOf(c); const m = await themeMeta(c.params.id);
    if (!m || m.builtin) throw E(404, 'no_theme', 'Theme not found');
    if (c.params.action === 'approve') await db.update('themes', { id: m.ref }, { status: 'public', review_note: '' });
    else if (c.params.action === 'reject') await db.update('themes', { id: m.ref }, { status: 'rejected', review_note: str(c.body.note, 300) || 'Not accepted for the theme store.' });
    else throw E(404, 'not_found', 'Not found');
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
  on('GET', '/api/admin/store', async c => { staffOf(c); const t = c.tenant, meta = await activeMeta(t); return { slug: t.slug, name: t.name, status: t.status, theme: themeValues(meta, t), theme_ref: meta.ref, theme_name: meta.manifest.name, settings: t.settings || {}, fonts: FONTS }; });
  // the active theme's settings (only settings the theme knows are kept)
  on('PUT', '/api/admin/theme', async c => {
    staffOf(c, ['owner']);
    const meta = await activeMeta(c.tenant), pkg = await themePkg(meta.ref);
    const th = { ...(c.tenant.theme || {}), ...TH.cleanValues(TH.fullSchema(meta.manifest.settings), c.body, pkg.assets) };
    await db.update('tenants', { id: c.tenant.id }, { theme: th });
    return { theme: themeValues(meta, { theme: th }) };
  });
  on('GET', '/api/admin/themes', async c => {
    staffOf(c, ['owner']); const t = c.tenant;
    const [pub, own] = await Promise.all([db.select('themes', { status: 'public' }, { cols: THEME_COLS, order: 'name' }), db.select('themes', { tenant_id: t.id }, { cols: THEME_COLS, order: 'updated_at', desc: true })]);
    const rows = [...own, ...pub.filter(p => p.tenant_id !== t.id)], names = await storeNames(rows.map(r => r.tenant_id));
    const builtins = await Promise.all(Object.keys(BUILT).map(themeMeta));
    return { current: t.theme_ref || DEFAULT_THEME_REF, themes: [...builtins, ...rows.map(r => ({ ref: r.id, builtin: false, ...r }))].map(m => themeCard(m, t, names)) };
  });
  on('GET', '/api/admin/themes/:ref', async c => {
    staffOf(c, ['owner']); const t = c.tenant, m = await themeMeta(c.params.ref);
    if (!canUseTheme(m, t)) throw E(404, 'no_theme', 'Theme not found');
    return { theme: themeCard(m, t, await storeNames([m.tenant_id])), settings: TH.fullSchema(m.manifest.settings), values: themeValues(m, t), current: (t.theme_ref || DEFAULT_THEME_REF) === m.ref };
  });
  on('POST', '/api/admin/themes', async c => {
    staffOf(c, ['owner']); const t = c.tenant, b64 = c.body.zip;
    if (typeof b64 !== 'string' || !b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw E(400, 'bad_theme', 'Choose a theme .zip file');
    const pkg = TH.checkPackage(TH.readZip(Buffer.from(b64, 'base64'))), slug = TH.slugOf(pkg.manifest.name);
    const row = { name: pkg.manifest.name, slug, version: pkg.manifest.version, manifest: pkg.manifest, css: pkg.css, templates: pkg.templates, assets: pkg.assets, preview: pkg.preview, hash: pkg.hash, updated_at: now().toISOString() };
    const ex = (await db.select('themes', { tenant_id: t.id, slug }, { limit: 1, cols: THEME_COLS }))[0];
    let saved;
    if (ex) saved = (await db.update('themes', { id: ex.id }, { ...row, status: ['public', 'review'].includes(ex.status) ? 'review' : 'private', review_note: '' }))[0];
    else {
      if ((await db.select('themes', { tenant_id: t.id }, { cols: 'id' })).length >= 10) throw E(400, 'too_many_themes', 'A store can keep up to 10 uploaded themes. Delete one first.');
      saved = await db.insert('themes', { ...row, tenant_id: t.id, status: 'private' });
    }
    return { status: ex ? 200 : 201, body: { theme: themeCard({ ref: saved.id, builtin: false, ...saved }, t), replaced: !!ex } };
  }, { max: 4_200_000 });
  on('POST', '/api/admin/themes/:ref/use', async c => {
    staffOf(c, ['owner']); const m = await themeMeta(c.params.ref);
    if (!canUseTheme(m, c.tenant)) throw E(404, 'no_theme', 'Theme not found');
    // by default the store starts from the theme's own colours, fonts and words (its logo stays); keep_look keeps what the store had
    const keep = c.body.keep_look === true, logo = (c.tenant.theme || {}).logo;
    await db.update('tenants', { id: c.tenant.id }, { theme_ref: m.ref, ...(keep ? {} : { theme: logo ? { logo } : {} }) });
    return { ok: true, current: m.ref };
  });
  on('POST', '/api/admin/themes/:ref/:action', async c => {
    staffOf(c, ['owner']); const m = await themeMeta(c.params.ref), a = c.params.action;
    if (!m || m.builtin || m.tenant_id !== c.tenant.id) throw E(404, 'no_theme', 'Theme not found');
    if (a === 'submit') { if (!['private', 'rejected'].includes(m.status)) throw E(409, 'bad_state', 'This theme is already shared or waiting for review'); await db.update('themes', { id: m.ref }, { status: 'review', review_note: '' }); }
    else if (a === 'withdraw') await db.update('themes', { id: m.ref }, { status: 'private' });
    else throw E(404, 'not_found', 'Not found');
    return { ok: true };
  });
  on('DELETE', '/api/admin/themes/:ref', async c => {
    staffOf(c, ['owner']); const m = await themeMeta(c.params.ref);
    if (!m || m.builtin || m.tenant_id !== c.tenant.id) throw E(404, 'no_theme', 'Theme not found');
    await db.update('tenants', { theme_ref: m.ref }, { theme_ref: DEFAULT_THEME_REF });  // every store using it goes back to the default
    await db.delete('themes', { id: m.ref });
    return { ok: true };
  });
  async function downloadTheme(ref) {
    const p = await themePkg(ref); if (!p) throw E(404, 'no_theme', 'Theme not found');
    return { filename: TH.slugOf(p.manifest.name) + '-' + p.manifest.version + '.zip', zip: TH.writeZip(TH.packageFiles(p)).toString('base64') };
  }
  on('GET', '/api/admin/themes/:ref/download', async c => { staffOf(c, ['owner']); const m = await themeMeta(c.params.ref); if (!canUseTheme(m, c.tenant)) throw E(404, 'no_theme', 'Theme not found'); return downloadTheme(m.ref); });
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
  on('GET', '/api/platform', async () => ({ turnstile_site_key: env.TURNSTILE_SITE_KEY || null, domain: PLATFORM || null }));
  on('GET', '/api/admin/staff', async c => {
    staffOf(c, ['owner']);
    return { rows: (await db.select('users', { tenant_id: c.tenant.id })).map(({ id, email, name, role, created_at }) => ({ id, email, name, role, created_at })) };
  });
  on('DELETE', '/api/admin/staff/:id', async c => {
    staffOf(c, ['owner']);
    if (!(await db.delete('users', { id: c.params.id, tenant_id: c.tenant.id, role: 'staff' }))) throw E(404, 'not_found');
    return { ok: true };
  });
  on('POST', '/api/admin/staff', async c => {
    staffOf(c, ['owner']); const email = str(c.body.email, 120).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || String(c.body.password || '').length < 10) throw E(400, 'bad_staff', 'Valid email and 10+ character password');
    try { await db.insert('users', { tenant_id: c.tenant.id, email, name: str(c.body.name, 80), role: 'staff', cred: await mkCred(c.body.password) }); }
    catch (e) { if (e.code === 'duplicate') throw E(409, 'exists', 'That email already has an account'); throw e; }
    return { ok: true };
  });

  // generic tenant-scoped CRUD for warehouses, products, variants, courier zones
  for (const [path, table] of [['warehouses', 'warehouses'], ['products', 'products'], ['variants', 'variants'], ['zones', 'courier_zones'], ['coupons', 'coupons']]) {
    const writer = ['warehouses', 'courier_zones', 'coupons'].includes(table) ? ['owner'] : ['owner', 'staff'];
    on('GET', `/api/admin/${path}`, async c => { staffOf(c); return { rows: await db.select(table, { tenant_id: c.tenant.id }) }; });
    on('POST', `/api/admin/${path}`, async c => {
      staffOf(c, writer); const row = pickFields(table, c.body, false);
      await ownRefs(c.tenant.id, row);
      try { return { row: await db.insert(table, { ...row, tenant_id: c.tenant.id }) }; }
      catch (e) { if (e.code === 'duplicate') throw E(409, 'exists', table === 'coupons' ? 'That coupon code already exists' : 'Already exists'); throw e; }
    });
    on('PATCH', `/api/admin/${path}/:id`, async c => {
      staffOf(c, writer); const row = pickFields(table, c.body, true); await ownRefs(c.tenant.id, row);
      let up; try { up = await db.update(table, { id: c.params.id, tenant_id: c.tenant.id }, row); } catch (e) { if (e.code === 'duplicate') throw E(409, 'exists', 'That coupon code already exists'); throw e; }
      if (!up.length) throw E(404, 'not_found'); return { row: up[0] };
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
  on('GET', '/api/admin/b2b', async c => { staffOf(c, ['owner']); return { rows: (await db.select('b2b_accounts', { tenant_id: c.tenant.id })).map(({ cred, ...a }) => a) }; });
  on('POST', '/api/admin/b2b', async c => {
    staffOf(c, ['owner']); const b = c.body, login = str(b.login, 40).toLowerCase(), name = str(b.name, 80);
    if (!name) throw E(400, 'bad_name', 'Business name is required');
    if (!okLogin(login)) throw E(400, 'bad_login', 'Username: 3–20 letters, numbers, . or _');
    if (String(b.password || '').length < 10) throw E(400, 'weak_password', 'Password must be 10+ characters');
    try { const { cred, ...a } = await db.insert('b2b_accounts', { tenant_id: c.tenant.id, name, phone: digits(b.phone).slice(0, 16), login, cred: await mkCred(b.password) }); return { row: a }; }
    catch (e) { if (e.code === 'duplicate') throw E(409, 'exists', 'That username is taken'); throw e; }
  });
  on('PATCH', '/api/admin/b2b/:id', async c => {
    staffOf(c, ['owner']); const b = c.body, patch = {};
    if ('name' in b) { patch.name = str(b.name, 80); if (!patch.name) throw E(400, 'bad_name'); }
    if ('phone' in b) patch.phone = digits(b.phone).slice(0, 16);
    if ('active' in b) patch.active = b.active !== false;
    if (b.password) { if (String(b.password).length < 10) throw E(400, 'weak_password', 'Password must be 10+ characters'); patch.cred = await mkCred(b.password); }
    const up = await db.update('b2b_accounts', { id: c.params.id, tenant_id: c.tenant.id }, patch); if (!up.length) throw E(404, 'not_found');
    const { cred, ...a } = up[0]; return { row: a };
  });
  on('DELETE', '/api/admin/b2b/:id', async c => { staffOf(c, ['owner']); if (!(await db.delete('b2b_accounts', { id: c.params.id, tenant_id: c.tenant.id }))) throw E(404, 'not_found'); return { ok: true }; });
  on('GET', '/api/admin/complaints', async c => { staffOf(c); return { rows: await db.select('complaints', { tenant_id: c.tenant.id }, { order: 'created_at', desc: true, limit: 200 }) }; });
  on('GET', '/api/admin/complaints/:no/images', async c => {
    staffOf(c); const cm = await db.one('complaints', { tenant_id: c.tenant.id, order_no: c.params.no }); if (!cm) throw E(404, 'not_found');
    return { images: (await db.select('complaint_images', { tenant_id: c.tenant.id, complaint_id: cm.id }, { order: 'position' })).map(i => i.data) };
  });
  on('PATCH', '/api/admin/complaints/:no', async c => {
    staffOf(c); const status = str(c.body.status, 12); if (!['open', 'resolved', 'rejected'].includes(status)) throw E(400, 'bad_status');
    const up = await db.update('complaints', { tenant_id: c.tenant.id, order_no: c.params.no }, { status, note: str(c.body.note, 300) }); if (!up.length) throw E(404, 'not_found'); return { row: up[0] };
  });
  on('GET', '/api/admin/reviews', async c => { staffOf(c); return { rows: await db.select('reviews', { tenant_id: c.tenant.id }, { order: 'created_at', desc: true, limit: 200 }) }; });
  on('DELETE', '/api/admin/reviews/:id', async c => { staffOf(c); if (!(await db.delete('reviews', { id: c.params.id, tenant_id: c.tenant.id }))) throw E(404, 'not_found'); return { ok: true }; });
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
    const up = await db.update('orders', { id: o.id, status: o.status }, { status: to, ...(to === 'delivered' ? { delivered_at: now().toISOString() } : {}) });
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
    const send = (status, body, cookies = [], extra = {}) => {
      const h = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...cors, ...extra });
      cookies.forEach(k => h.append('set-cookie', k));
      return new Response(JSON.stringify(body), { status, headers: h });
    };
    try {
      let route, params;
      for (const r of R) { if (r.method !== req.method) continue; const m = r.re.exec(url.pathname); if (m) { route = r; params = m.groups || {}; break; } }
      if (!route) throw E(404, 'not_found', 'Not found');
      let raw = '', body = {};
      if (!['GET', 'DELETE'].includes(req.method)) {
        raw = await req.text(); if (raw.length > route.max) throw E(413, 'too_large', 'That is too big to send');
        if (raw) { try { body = JSON.parse(raw); } catch { throw E(400, 'bad_json'); } }
        if (!isObj(body)) throw E(400, 'bad_json');
      }
      const c = { req, url, params, raw, body, sess: sessionOf(req), ip: req.headers.get('x-nf-client-connection-ip') || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'local' };
      c.tenant = url.pathname.startsWith('/api/webhook/') || url.pathname.startsWith('/api/super/') || url.pathname === '/api/cron/sweep' ? null : await resolveTenant(req, url);
      const out = await route.fn(c);
      if (out && 'body' in out && ('cookies' in out || 'status' in out || 'headers' in out)) return send(out.status || 200, out.body, out.cookies, out.headers);
      return send(200, out);
    } catch (e) {
      if (e.status) return send(e.status, { error: e.code, message: e.message });
      console.error(e);
      return send(500, { error: 'server_error', message: 'Something went wrong' });
    }
  }
  return { handle, sweep };
}
