// Copies ../public into ./www and points the app at your platform API.
//   PLATFORM_URL=https://order.example.com npm run prepare:www
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', '..', 'public');
const out = path.join(here, '..', 'www');
const url = (process.env.PLATFORM_URL || '').replace(/\/+$/, '');
if (!/^https:\/\/[^\s/]+$/.test(url)) { console.error('Set PLATFORM_URL to your https site, e.g. PLATFORM_URL=https://order.example.com'); process.exit(1); }
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(src, out, { recursive: true });
fs.writeFileSync(path.join(out, 'config.js'), `window.SO_API = ${JSON.stringify(url)};\n`);
fs.copyFileSync(path.join(out, 'index.html'), path.join(out, 'app.html'));
console.log('www ready, API =', url);
