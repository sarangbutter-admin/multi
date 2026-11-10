// Local dev server with the in-memory database: npm run dev → http://localhost:8888
import http from 'node:http';
import { makeApp } from '../lib/app.mjs';
import { memoryDb } from '../lib/db-memory.mjs';

const app = makeApp({ db: memoryDb(), env: { SESSION_SECRET: 'dev-session-secret-0123456789abcdef', MASTER_KEY: 'dev-master-key-0123456789abcdef0123', SUPER_SETUP_KEY: 'dev-setup-key-123456', PLATFORM_DOMAIN: 'localhost' } });
http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const r = await app.handle(new Request('http://' + req.headers.host + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }));
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
}).listen(8888, () => console.log('http://localhost:8888  (use header  X-Tenant: <slug>)'));
