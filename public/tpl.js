// Theme templates: a small Mustache-style language plus an allow-list HTML cleaner.
// Used by the storefront (browser) and by the server to check uploaded themes. No JavaScript from themes ever runs.
//   {{name}} {{a.b}} {{.}}        text, always escaped
//   {{#list}}…{{/list}}           repeat for each item, or show when true
//   {{^list}}…{{/list}}           show when empty or false
//   {{> card}}                    include another template
//   {{! note }}                   comment
const NAME = /^(\.|[A-Za-z_][\w-]*(\.[A-Za-z_][\w-]*)*)$/;
const TAG = /\{\{([\s\S]*?)\}\}/g;

export function parse(src, { partials = [] } = {}) {
  if (typeof src !== 'string') throw new Error('Template must be text');
  const root = [], stack = [{ name: null, kids: root }];
  let last = 0, m;
  TAG.lastIndex = 0;
  const line = i => src.slice(0, i).split('\n').length;
  while ((m = TAG.exec(src))) {
    if (m.index > last) stack.at(-1).kids.push({ t: 'text', v: src.slice(last, m.index) });
    last = TAG.lastIndex;
    let inner = m[1];
    if (inner.startsWith('{')) throw new Error(`Line ${line(m.index)}: {{{ }}} is not supported. Every value is escaped`);
    const kind = /^[#^/>!]/.test(inner.trim()) ? inner.trim()[0] : '';
    if (kind === '!') continue;
    const name = (kind ? inner.trim().slice(1) : inner).trim();
    if (!NAME.test(name)) throw new Error(`Line ${line(m.index)}: "{{${inner}}}" is not a valid tag`);
    if (kind === '#' || kind === '^') { const node = { t: kind === '#' ? 'sec' : 'inv', name, kids: [] }; stack.at(-1).kids.push(node); stack.push(node); }
    else if (kind === '/') {
      const open = stack.pop();
      if (!open.name || open.name !== name) throw new Error(`Line ${line(m.index)}: {{/${name}}} closes ${open.name ? `{{#${open.name}}}` : 'nothing'}`);
    }
    else if (kind === '>') { if (!partials.includes(name)) throw new Error(`Line ${line(m.index)}: unknown template "${name}"`); stack.at(-1).kids.push({ t: 'part', name }); }
    else stack.at(-1).kids.push({ t: 'var', name });
  }
  if (stack.length > 1) throw new Error(`{{#${stack.at(-1).name}}} is never closed`);
  if (last < src.length) root.push({ t: 'text', v: src.slice(last) });
  return root;
}

const esc = s => String(s).replace(/[&<>"'`=]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;', '=': '&#61;' })[c]);
function lookup(name, stack) {
  if (name === '.') return stack.at(-1);
  const [head, ...rest] = name.split('.');
  for (let i = stack.length - 1; i >= 0; i--) {
    const f = stack[i];
    if (f && typeof f === 'object' && Object.prototype.hasOwnProperty.call(f, head)) {
      let v = f[head];
      for (const k of rest) v = v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, k) ? v[k] : undefined;
      return v;
    }
  }
  return undefined;
}
const cache = new Map();
const compiled = (src, partials) => { const k = partials.join() + '\0' + src; if (!cache.has(k)) { if (cache.size > 50) cache.clear(); cache.set(k, parse(src, { partials })); } return cache.get(k); };

export function render(src, data, partials = {}) {
  const names = Object.keys(partials);
  const run = (nodes, stack, depth) => {
    if (depth > 6) return '';
    let out = '';
    for (const n of nodes) {
      if (n.t === 'text') out += n.v;
      else if (n.t === 'var') { const v = lookup(n.name, stack); if (v != null && v !== false && typeof v !== 'object') out += esc(v); }
      else if (n.t === 'part') out += run(compiled(partials[n.name], names), stack, depth + 1);
      else {
        const v = lookup(n.name, stack), empty = !v || (Array.isArray(v) && !v.length);
        if (n.t === 'inv') { if (empty) out += run(n.kids, stack, depth); }
        else if (!empty) out += Array.isArray(v) ? v.map(x => run(n.kids, [...stack, x], depth)).join('') : run(n.kids, typeof v === 'object' ? [...stack, v] : stack, depth);
      }
    }
    return out;
  };
  return run(compiled(src, names), [data], 0);
}

// What a theme template may contain. Checked when a theme is uploaded, and the browser cleans the output again.
export const BLOCKED = /<\s*\/?\s*(script|style|iframe|frame|frameset|object|embed|applet|form|link|meta|base|template|noscript|textarea|select|option|math|foreignobject|use|animate|set)\b|\son[a-z]+\s*=|javascript\s*:|vbscript\s*:|srcdoc\s*=|formaction\s*=|xlink:href/i;

const TAGS = new Set(('a abbr article aside b bdi br button caption circle code dd del details dfn div dl dt ellipse em figcaption figure footer g h1 h2 h3 h4 h5 h6 header hr i img input ins kbd label li line main mark nav ol p path picture polygon polyline pre q rect s section small source span strong sub summary sup svg table tbody td tfoot th thead time tr u ul').split(' '));
const DROP = new Set('script style iframe frame frameset object embed applet form link meta base template noscript textarea select math title'.split(' '));
const ATTRS = new Set(('alt aria-hidden aria-label aria-labelledby aria-describedby aria-current aria-expanded aria-pressed class colspan cx cy d datetime decoding dir disabled fill fill-rule clip-rule focusable height hidden href id lang loading open placeholder points r rel role rowspan rx ry src stroke stroke-linecap stroke-linejoin stroke-width style tabindex target title transform type viewbox width x x1 x2 y y1 y2 xmlns autocomplete enterkeyhint inputmode sizes media srcset spellcheck').split(' '));
const SAFE_URL = /^(https?:\/\/|mailto:|tel:|#|\?|\/(?!\/)|data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,)/i;
const okUrl = v => { const s = v.trim(); return SAFE_URL.test(s) || !/^[\w+.-]*:/.test(s) && !s.startsWith('//'); };

// browser only: returns a DocumentFragment with anything unsafe removed
export function clean(html) {
  const t = document.createElement('template');
  t.innerHTML = html;
  (function walk(node) {
    for (const el of [...node.children]) {
      const tag = el.localName.toLowerCase();
      if (!TAGS.has(tag)) { if (DROP.has(tag)) el.remove(); else { walk(el); el.replaceWith(...el.childNodes); } continue; }
      for (const a of [...el.attributes]) {
        const n = a.name.toLowerCase(), v = a.value;
        const ok = (ATTRS.has(n) || n.startsWith('data-') || n.startsWith('aria-'))
          && (!['href', 'src'].includes(n) || okUrl(v))
          && (n !== 'srcset' || v.split(',').every(p => okUrl(p.trim().split(/\s+/)[0] || '')))
          && (n !== 'style' || !/url\s*\(|expression|javascript|@import|behavior|binding/i.test(v))
          && (n !== 'type' || tag !== 'input' || /^(search|text)$/i.test(v))
          && (n !== 'target' || v === '_blank');
        if (!ok) el.removeAttribute(a.name);
      }
      if (tag === 'input' && !/^(search|text)$/i.test(el.getAttribute('type') || 'text')) { el.remove(); continue; }
      if (tag === 'a' && el.getAttribute('target') === '_blank') el.setAttribute('rel', 'noopener noreferrer');
      if (tag === 'button' && !el.hasAttribute('type')) el.setAttribute('type', 'button');
      walk(el);
    }
  })(t.content);
  return t.content;
}

if (typeof window !== 'undefined') window.TPL = { parse, render, clean };
