// Theme packages: read/write .zip, check everything in it, and turn it into what the storefront needs.
// A theme is: theme.json (name + settings), theme.css, templates/layout.html, templates/card.html, assets/* (images).
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { parse as parseTemplate, BLOCKED } from '../public/tpl.js';

const E = (message, code = 'bad_theme', status = 400) => Object.assign(new Error(message), { status, code });
const isObj = x => x && typeof x === 'object' && !Array.isArray(x);
const HEX = /^#[0-9a-fA-F]{6}$/;
export const FONTS = ['Inter', 'Poppins', 'Nunito', 'DM Sans', 'Plus Jakarta Sans', 'Fredoka', 'Playfair Display', 'Space Grotesk', 'Outfit', 'Manrope', 'Lora', 'Rubik'];
export const LIMITS = { zip: 3_000_000, total: 6_000_000, files: 120, template: 60_000, css: 150_000, asset: 400_000, assets: 1_500_000 };
const IMG_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml' };
export const TEMPLATES = ['layout', 'card'];

// ── zip ──
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xFFFFFFFF; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };

export function readZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw E('That file is not a .zip');
  if (buf.length > LIMITS.zip) throw E(`The .zip is too big (max ${LIMITS.zip / 1e6} MB)`);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw E('That file is not a .zip');
  const count = buf.readUInt16LE(eocd + 10), cdAt = buf.readUInt32LE(eocd + 16);
  if (count > LIMITS.files) throw E(`Too many files in the .zip (max ${LIMITS.files})`);
  const files = {}; let p = cdAt, total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw E('The .zip is damaged');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen).replace(/\\/g, '/');
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/') || /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db)/.test(name)) continue;
    if (name.includes('..') || name.startsWith('/')) throw E(`Bad file name in the .zip: ${name}`);
    total += size; if (total > LIMITS.total) throw E('The theme is too big when unpacked');
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw E('The .zip is damaged');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28), raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) { try { data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) }); } catch { throw E(`Can't unpack ${name}`); } }
    else throw E(`Unsupported compression for ${name}`);
    if (data.length !== size) throw E(`The .zip is damaged (${name})`);
    files[name] = data;
  }
  // allow a zip made from the theme folder itself ("my-theme/theme.json")
  const names = Object.keys(files), top = names[0]?.split('/')[0];
  if (!files['theme.json'] && top && names.every(n => n.startsWith(top + '/'))) return Object.fromEntries(names.map(n => [n.slice(top.length + 1), files[n]]));
  return files;
}

export function writeZip(files) {
  const parts = [], central = []; let off = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content), comp = zlib.deflateRawSync(data), n = Buffer.from(name), crc = crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    parts.push(lh, n, comp); central.push(ch, n); off += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}

// ── settings ──
// Every theme gets these, so the storefront always has colours, a font and a logo. A theme may override any of them.
export const CORE_SETTINGS = [
  { type: 'header', label: 'Colours and type' },
  { id: 'primary', type: 'color', label: 'Main colour', default: '#1F6F4A' },
  { id: 'accent', type: 'color', label: 'Highlight', default: '#FFD23F' },
  { id: 'background', type: 'color', label: 'Background', default: '#F3F7F2' },
  { id: 'surface', type: 'color', label: 'Cards', default: '#FFFFFF' },
  { id: 'text', type: 'color', label: 'Text', default: '#13241B' },
  { id: 'font', type: 'font', label: 'Font', default: 'Plus Jakarta Sans' },
  { id: 'radius', type: 'range', label: 'Corner roundness', min: 0, max: 32, step: 1, default: 14 },
  { id: 'logo', type: 'image', label: 'Logo', info: 'Square image link (https://)', default: '' }
];
const TYPES = ['header', 'color', 'text', 'textarea', 'image', 'select', 'range', 'checkbox', 'font'];
const ID = /^[a-z][a-z0-9_]{0,31}$/;

function checkValue(s, v, assets) {
  const bad = msg => { throw E(`${s.label || s.id}: ${msg}`); };
  switch (s.type) {
    case 'color': if (typeof v !== 'string' || !HEX.test(v)) bad('use a #RRGGBB colour'); return v.toUpperCase();
    case 'text': case 'textarea': { if (typeof v !== 'string') bad('must be text'); const max = s.type === 'text' ? 200 : 1000; return v.trim().slice(0, max); }
    case 'image': {
      if (typeof v !== 'string') bad('must be a link');
      const u = v.trim();
      if (u && !/^https:\/\/[^\s"'<>()]+$/.test(u) && !/^\/(media|demo)\/[\w./-]+$/.test(u) && !(u.startsWith('asset:') && assets && u.slice(6) in assets)) bad('use an https:// image link');
      return u.slice(0, 500);
    }
    case 'select': if (!s.options.some(o => o.value === v)) bad('pick one of the options'); return v;
    case 'range': { const n = Number(v); if (!isFinite(n) || n < s.min || n > s.max) bad(`must be between ${s.min} and ${s.max}`); return n; }
    case 'checkbox': return v === true;
    case 'font': if (!FONTS.includes(v)) bad('pick one of the fonts'); return v;
  }
}

function checkSettings(list, assets) {
  if (list == null) return [];
  if (!Array.isArray(list) || list.length > 80) throw E('"settings" must be a list (max 80)');
  const seen = new Set();
  return list.map((s, i) => {
    if (!isObj(s) || !TYPES.includes(s.type)) throw E(`Setting ${i + 1}: "type" must be one of ${TYPES.join(', ')}`);
    const label = typeof s.label === 'string' ? s.label.trim().slice(0, 60) : '';
    if (s.type === 'header') { if (!label) throw E(`Setting ${i + 1}: a header needs a label`); return { type: 'header', label }; }
    if (!ID.test(s.id || '')) throw E(`Setting ${i + 1}: "id" must be lowercase letters, numbers and _`);
    if (seen.has(s.id)) throw E(`Setting "${s.id}" appears twice`); seen.add(s.id);
    const out = { id: s.id, type: s.type, label: label || s.id };
    if (typeof s.info === 'string' && s.info.trim()) out.info = s.info.trim().slice(0, 160);
    if (s.type === 'select') {
      if (!Array.isArray(s.options) || !s.options.length || s.options.length > 20) throw E(`Setting "${s.id}": "options" needs 1–20 choices`);
      out.options = s.options.map(o => (isObj(o) ? { value: String(o.value), label: String(o.label ?? o.value).slice(0, 60) } : { value: String(o), label: String(o) }));
    }
    if (s.type === 'range') {
      for (const k of ['min', 'max']) if (typeof s[k] !== 'number') throw E(`Setting "${s.id}": "${k}" must be a number`);
      if (s.min >= s.max) throw E(`Setting "${s.id}": "min" must be below "max"`);
      out.min = s.min; out.max = s.max; out.step = typeof s.step === 'number' && s.step > 0 ? s.step : 1;
    }
    const def = s.default ?? { color: '#000000', checkbox: false, range: s.min, select: out.options?.[0]?.value, font: 'Inter' }[s.type] ?? '';
    out.default = checkValue(out, def, assets);
    return out;
  });
}

// the theme's own settings with the core ones added in front (unless the theme defines them)
export function fullSchema(settings) {
  const mine = new Set(settings.filter(s => s.id).map(s => s.id));
  const core = CORE_SETTINGS.filter(s => !s.id || !mine.has(s.id));
  return core.every(s => !s.id) ? settings : [...core, ...settings];
}
export const defaults = schema => Object.fromEntries(schema.filter(s => s.id).map(s => [s.id, s.default]));
// owner input → clean values (only known settings; unknown ones are ignored)
export function cleanValues(schema, input, assets) {
  if (!isObj(input)) throw E('Send the settings as an object');
  const out = {};
  for (const s of schema) if (s.id && s.id in input) out[s.id] = checkValue(s, input[s.id], assets);
  return out;
}

// ── package check ──
function checkCss(css, assets) {
  if (css.length > LIMITS.css) throw E(`theme.css is too big (max ${LIMITS.css / 1000} KB)`);
  const bad = [[/@import/i, '@import'], [/expression\s*\(/i, 'expression()'], [/javascript\s*:|vbscript\s*:/i, 'javascript: links'], [/-moz-binding|behavior\s*:/i, 'behavior/binding'], [/<\/?\s*(style|script)/i, '<style>/<script> tags'], [/@namespace/i, '@namespace']];
  for (const [re, what] of bad) if (re.test(css)) throw E(`theme.css can't use ${what}`);
  for (const m of css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
    const u = m[2];
    if (u.startsWith('asset:')) { if (!(u.slice(6) in assets)) throw E(`theme.css uses ${u} but assets/${u.slice(6)} is not in the theme`); }
    else if (!/^data:image\/(png|jpe?g|webp|gif|svg\+xml)[;,]/i.test(u)) throw E(`theme.css can only load images from the theme's own assets (url(asset:name.png)), not ${u.slice(0, 60)}`);
  }
  return css;
}
function checkTemplate(name, src) {
  if (src.length > LIMITS.template) throw E(`templates/${name}.html is too big (max ${LIMITS.template / 1000} KB)`);
  const hit = BLOCKED.exec(src);
  if (hit) throw E(`templates/${name}.html can't contain "${hit[0].trim()}". Themes can't run scripts, load other pages or have forms`);
  try { parseTemplate(src, { partials: name === 'layout' ? ['card'] : [] }); } catch (e) { throw E(`templates/${name}.html: ${e.message}`); }
  if (name === 'card' && !/data-card\s*=\s*"\{\{\s*id\s*\}\}"/.test(src)) throw E('templates/card.html needs data-card="{{id}}" on its outer element');
  return src;
}

export function checkPackage(files) {
  const text = n => { const b = files[n]; if (!b) throw E(`The theme needs ${n}`); const s = b.toString('utf8'); if (s.includes('�')) throw E(`${n} must be UTF-8 text`); return s; };
  let m; try { m = JSON.parse(text('theme.json')); } catch (e) { throw e.code ? e : E('theme.json is not valid JSON'); }
  if (!isObj(m)) throw E('theme.json must be an object');
  const name = typeof m.name === 'string' ? m.name.trim().slice(0, 40) : '';
  if (name.length < 2) throw E('theme.json needs a "name"');
  const version = typeof m.version === 'string' && /^\d{1,3}\.\d{1,3}(\.\d{1,3})?$/.test(m.version) ? m.version : '1.0.0';
  const assets = {};
  let size = 0;
  for (const [path, buf] of Object.entries(files)) {
    if (!path.startsWith('assets/')) { if (!['theme.json', 'theme.css', 'README.md', ...TEMPLATES.map(t => `templates/${t}.html`)].includes(path)) throw E(`Unexpected file in the theme: ${path}`); continue; }
    const f = path.slice(7), ext = (f.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
    if (!/^[a-z0-9][a-z0-9_.-]{0,60}$/i.test(f) || !IMG_TYPES[ext]) throw E(`assets/${f}: only png, jpg, webp, gif and svg images are allowed`);
    if (buf.length > LIMITS.asset) throw E(`assets/${f} is too big (max ${LIMITS.asset / 1000} KB)`);
    if (ext === 'svg' && /<\s*script|\son[a-z]+\s*=|javascript:|<\s*foreignobject|href\s*=\s*["']?(?!#)/i.test(buf.toString('utf8'))) throw E(`assets/${f}: SVG images can't contain scripts or links`);
    size += buf.length; assets[f] = `data:${IMG_TYPES[ext]};base64,${buf.toString('base64')}`;
  }
  if (size > LIMITS.assets) throw E(`Images add up to more than ${LIMITS.assets / 1e6} MB`);
  const settings = checkSettings(m.settings, assets);
  const css = files['theme.css'] ? checkCss(text('theme.css'), assets) : '';
  const templates = Object.fromEntries(TEMPLATES.map(t => [t, checkTemplate(t, text(`templates/${t}.html`))]));
  const preview = ['preview.png', 'preview.jpg', 'preview.webp', 'preview.svg'].find(p => p in assets) || null;
  const manifest = { name, version, author: typeof m.author === 'string' ? m.author.trim().slice(0, 60) : '', description: typeof m.description === 'string' ? m.description.trim().slice(0, 300) : '', settings };
  const hash = crypto.createHash('sha256').update(JSON.stringify([manifest, css, templates, assets])).digest('hex').slice(0, 16);
  return { manifest, css, templates, assets, preview: preview ? assets[preview] : null, hash };
}
export const slugOf = name => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'theme';

// back to files (for "Download")
export function packageFiles(p) {
  const files = { 'theme.json': JSON.stringify({ ...p.manifest }, null, 2) + '\n', 'theme.css': p.css };
  for (const t of TEMPLATES) files[`templates/${t}.html`] = p.templates[t];
  for (const [n, d] of Object.entries(p.assets || {})) files['assets/' + n] = Buffer.from(d.slice(d.indexOf(',') + 1), 'base64');
  return files;
}

// what the storefront downloads: asset links already filled in
export function clientPackage(ref, p) {
  const css = p.css.replace(/url\(\s*(['"]?)asset:([^'")\s]+)\1\s*\)/gi, (_, q, n) => `url("${p.assets[n]}")`);
  return { ref, name: p.manifest.name, version: p.manifest.version, hash: p.hash, css, templates: p.templates, assets: p.assets, settings: fullSchema(p.manifest.settings) };
}
