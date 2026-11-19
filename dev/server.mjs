// Local dev server with an in-memory database and demo data: npm run dev → http://localhost:8888
//   demo coupon WELCOME10, business login corner.shop / demo-password-1 (store: fresh-basket)
//   shop:        http://localhost:8888/?store=fresh-basket
//   back office: http://localhost:8888/admin   (Store address box: fresh-basket → owner@fresh-basket.test / demo-password-1; leave the box empty for platform admin admin@demo.test / demo-admin-pass)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeApp } from '../lib/app.mjs';
import { memoryDb } from '../lib/db-memory.mjs';
import { seedDemo } from '../lib/demo.mjs';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const db = memoryDb();
const app = makeApp({ db, env: { SESSION_SECRET: 'dev-session-secret-0123456789abcdef', MASTER_KEY: 'dev-master-key-0123456789abcdef0123', SUPER_SETUP_KEY: 'dev-setup-key-123456', PLATFORM_DOMAIN: 'localhost', PUBLIC_BASE_URL: 'http://localhost:8888' } });

await seedDemo(db);

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
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
}).listen(8888, () => console.log('http://localhost:8888/?store=fresh-basket  ·  /admin'));
