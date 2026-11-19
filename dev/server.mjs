// Local dev server with an in-memory database and demo data: npm run dev → http://localhost:8888
//   demo coupon WELCOME10, business login cafe.biru / demo-password-1 (store: sarang)
//   shop:        http://localhost:8888/?store=sarang
//   back office: http://localhost:8888/admin   (owner: owner@sarang.test / demo-password-1, platform admin: admin@demo.test / demo-admin-pass)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeApp } from '../lib/app.mjs';
import { memoryDb } from '../lib/db-memory.mjs';
import { mkCred } from '../lib/crypto.mjs';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const db = memoryDb();
const app = makeApp({ db, env: { SESSION_SECRET: 'dev-session-secret-0123456789abcdef', MASTER_KEY: 'dev-master-key-0123456789abcdef0123', SUPER_SETUP_KEY: 'dev-setup-key-123456', PLATFORM_DOMAIN: 'localhost', PUBLIC_BASE_URL: 'http://localhost:8888' } });

async function seed() {
  await db.insert('users', { tenant_id: null, email: 'admin@demo.test', role: 'super', cred: await mkCred('demo-admin-pass') });
  const mk = async (slug, name, theme, about) => {
    const t = await db.insert('tenants', { slug, name, status: 'active', theme, settings: { payments: ['manual'], pickup: true, pay_minutes: 60, about, whatsapp: '6281200000000', tiers: { regular: { qty: 10, amt: 0, pct: 5 }, b2b: { qty: 1, amt: 0, pct: 15 } }, manual: { bank: 'BCA', account_no: '1234567890', account_name: name } } });
    await db.insert('users', { tenant_id: t.id, email: `owner@${slug}.test`, name: 'Owner', role: 'owner', cred: await mkCred('demo-password-1') });
    return t;
  };
  const sarang = await mk('sarang', 'Sarang Butter', { primary: '#9A3B1F', accent: '#F6C453', background: '#FFF6E8', surface: '#FFFFFF', text: '#2B1608', radius: 20, font: 'Fredoka', layout: 'grid' }, 'Small-batch butter cookies and brownies, baked every morning.');
  const kopi = await mk('kopi-pagi', 'Kopi Pagi', { primary: '#12372A', accent: '#C6F432', background: '#10201A', surface: '#18302A', text: '#EAF4E4', radius: 6, font: 'Space Grotesk', mode: 'dark', layout: 'list' }, 'Coffee and toast for early people.');
  const wj = await db.insert('warehouses', { tenant_id: sarang.id, name: 'Kitchen Jakarta', address: 'Jl. Kemang Raya 10', postal_code: '12730', lat: -6.2615, lng: 106.8106 });
  const wb = await db.insert('warehouses', { tenant_id: sarang.id, name: 'Kitchen Bandung', address: 'Jl. Braga 5', postal_code: '40111', lat: -6.9175, lng: 107.6191 });
  const menu = [['Butter cookies', 'Cookies', [['Box of 6', 55000, 400], ['Box of 12', 98000, 800]]], ['Salted caramel brownie', 'Brownies', [['Single', 22000, 90], ['Box of 4', 80000, 360]]], ['Cheese tart', 'Pastry', [['Single', 18000, 70]]], ['Sourdough loaf', 'Pastry', [['Whole', 65000, 700]]]];
  for (const [i, [name, category, vs]] of menu.entries()) {
    const p = await db.insert('products', { tenant_id: sarang.id, name, category, sort: i, description: `${name}, made fresh.` });
    for (const [vn, price, weight_g] of vs) {
      const v = await db.insert('variants', { tenant_id: sarang.id, product_id: p.id, name: vn, price, weight_g });
      await db.insert('stock', { tenant_id: sarang.id, warehouse_id: wj.id, variant_id: v.id, qty: 12, reserved: 0 });
      await db.insert('stock', { tenant_id: sarang.id, warehouse_id: wb.id, variant_id: v.id, qty: name === 'Cheese tart' ? 0 : 20, reserved: 0 });
    }
  }
  const wk = await db.insert('warehouses', { tenant_id: kopi.id, name: 'Kopi Pagi Tebet', address: 'Jl. Tebet Barat 3', postal_code: '12810', lat: -6.2386, lng: 106.8527 });
  for (const [name, category, price] of [['Iced latte', 'Coffee', 28000], ['Flat white', 'Coffee', 30000], ['Butter toast', 'Toast', 22000]]) {
    const p = await db.insert('products', { tenant_id: kopi.id, name, category, description: `${name}, made to order.` });
    const v = await db.insert('variants', { tenant_id: kopi.id, product_id: p.id, name, price, weight_g: 250 });
    await db.insert('stock', { tenant_id: kopi.id, warehouse_id: wk.id, variant_id: v.id, qty: 30, reserved: 0 });
  }
  await db.insert('coupons', { tenant_id: sarang.id, code: 'WELCOME10', type: 'pct', value: 10, min_purchase: 50000, max_uses: 100 });
  await db.insert('coupons', { tenant_id: sarang.id, code: 'FIVEK', type: 'amt', value: 5000 });
  await db.insert('b2b_accounts', { tenant_id: sarang.id, name: 'Cafe Biru', phone: '0811000111', login: 'cafe.biru', cred: await mkCred('demo-password-1') });
  await db.insert('courier_zones', { tenant_id: sarang.id, name: 'Nearby', max_km: 8, fee: 12000, eta: '45–90 minutes' });
  await db.insert('courier_zones', { tenant_id: sarang.id, name: 'City', max_km: 25, fee: 25000, eta: 'Same day' });
}
await seed();

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + req.headers.host);
  if (!url.pathname.startsWith('/api/')) {
    let f = url.pathname === '/admin' ? '/admin.html' : url.pathname.startsWith('/order/') ? '/index.html' : url.pathname === '/' ? '/index.html' : url.pathname;
    const full = path.join(PUBLIC, path.normalize(f));
    if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-store' });
    return res.end(fs.readFileSync(full));
  }
  const chunks = []; for await (const c of req) chunks.push(c);
  const r = await app.handle(new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }));
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
}).listen(8888, () => console.log('http://localhost:8888/?store=sarang  ·  /admin'));
