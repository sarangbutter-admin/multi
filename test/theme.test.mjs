import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { parse, render } from '../public/tpl.js';
import { readZip, writeZip, checkPackage, cleanValues, fullSchema, defaults, packageFiles, clientPackage } from '../lib/theme.mjs';

const T = (layout, card = '<div data-card="{{id}}">{{name}}</div>') => ({ 'templates/layout.html': Buffer.from(layout), 'templates/card.html': Buffer.from(card) });
const pkg = (extra = {}, manifest = { name: 'Test', settings: [] }) => ({ 'theme.json': Buffer.from(JSON.stringify(manifest)), ...T('<main>{{#products}}{{> card}}{{/products}}</main>'), ...extra });
const err = (fn, re) => assert.throws(fn, e => re.test(e.message), 'expected error ' + re);

test('templates: escaping, sections, partials and errors', () => {
  const out = render('<p title="{{t}}">{{a.b}}</p>{{#list}}<i>{{n}}{{x}}</i>{{/list}}{{^none}}empty{{/none}}{{#ok}}yes{{/ok}}{{> p}}',
    { t: '"><script>', a: { b: '<b>' }, list: [{ n: 1 }, { n: 2 }], x: '!', none: [], ok: true }, { p: '[{{a.b}}]' });
  assert.equal(out, '<p title="&quot;&gt;&lt;script&gt;">&lt;b&gt;</p><i>1!</i><i>2!</i>empty' + 'yes' + '[&lt;b&gt;]');
  assert.equal(render('{{#o}}{{k}}{{/o}}{{missing.deep}}{{obj}}', { o: { k: 'v' }, obj: { x: 1 } }), 'v');
  err(() => parse('{{#a}}x'), /never closed/);
  err(() => parse('{{#a}}{{/b}}'), /closes/);
  err(() => parse('{{{raw}}}'), /not supported/);
  err(() => parse('{{> other}}', { partials: ['card'] }), /unknown template/);
  err(() => parse('{{a b}}'), /not a valid tag/);
});

test('zip: write and read back, also from a folder', () => {
  const files = { 'theme.json': '{"a":1}', 'assets/x.png': Buffer.from([1, 2, 3, 250]) };
  const back = readZip(writeZip(files));
  assert.equal(back['theme.json'].toString(), '{"a":1}'); assert.deepEqual([...back['assets/x.png']], [1, 2, 3, 250]);
  const nested = readZip(writeZip({ 'my-theme/theme.json': 'x', 'my-theme/theme.css': 'y' }));
  assert.deepEqual(Object.keys(nested).sort(), ['theme.css', 'theme.json']);
  err(() => readZip(Buffer.from('not a zip at all, sorry about that')), /not a \.zip/);
  err(() => readZip(writeZip({ '../evil.txt': 'x' })), /Bad file name/);
});

test('theme packages: unsafe things are refused', () => {
  assert.ok(checkPackage(pkg()).hash);
  err(() => checkPackage(pkg(T('<script>alert(1)</script>'))), /can't contain/);
  err(() => checkPackage(pkg(T('<img src="x" onerror="alert(1)">'))), /can't contain/);
  err(() => checkPackage(pkg(T('<a href="javascript:alert(1)">x</a>'))), /can't contain/);
  err(() => checkPackage(pkg(T('<form action="https://evil.test"></form>'))), /can't contain/);
  err(() => checkPackage(pkg(T('<iframe src="https://evil.test"></iframe>'))), /can't contain/);
  err(() => checkPackage(pkg(T('<div>{{#a}}</div>'))), /never closed/);
  err(() => checkPackage(pkg(T('<div></div>', '<div>{{name}}</div>'))), /data-card/);
  err(() => checkPackage(pkg({ 'theme.css': Buffer.from('@import url(https://evil.test/a.css);') })), /@import/);
  err(() => checkPackage(pkg({ 'theme.css': Buffer.from('a{background:url(https://evil.test/track.png)}') })), /own assets/);
  err(() => checkPackage(pkg({ 'theme.css': Buffer.from('a{background:url(asset:nope.png)}') })), /not in the theme/);
  err(() => checkPackage(pkg({ 'assets/x.svg': Buffer.from('<svg><script>alert(1)</script></svg>') })), /scripts or links/);
  err(() => checkPackage(pkg({ 'assets/x.exe': Buffer.from('MZ') })), /only png/);
  err(() => checkPackage(pkg({ 'other.js': Buffer.from('x') })), /Unexpected file/);
  err(() => checkPackage(pkg({}, { name: 'Xy', settings: [{ id: 'c', type: 'color', default: 'red' }] })), /colour/);
  err(() => checkPackage(pkg({}, { name: 'Xy', settings: [{ id: 'a', type: 'code' }] })), /type/);
  err(() => checkPackage({ ...pkg(), 'theme.json': Buffer.from('{oops') }), /not valid JSON/);
  // assets and settings that are fine
  const ok = checkPackage(pkg({ 'assets/hero.png': Buffer.from('png'), 'theme.css': Buffer.from('.h{background:url(asset:hero.png)}') },
    { name: 'Good', settings: [{ id: 'hero', type: 'image', default: 'asset:hero.png' }, { id: 'n', type: 'range', min: 1, max: 5, default: 3 }, { id: 's', type: 'select', options: ['a', 'b'] }] }));
  const schema = fullSchema(ok.manifest.settings);
  assert.ok(schema.some(s => s.id === 'primary'), 'core colours are always editable');
  assert.deepEqual([defaults(schema).n, defaults(schema).s, defaults(schema).hero], [3, 'a', 'asset:hero.png']);
  assert.deepEqual(cleanValues(schema, { n: 4, s: 'b', unknown: 1, primary: '#abcdef' }, ok.assets), { n: 4, s: 'b', primary: '#ABCDEF' });
  err(() => cleanValues(schema, { n: 9 }, ok.assets), /between/);
  err(() => cleanValues(schema, { hero: 'http://plain.test/x.png' }, ok.assets), /https/);
  assert.match(clientPackage('x', ok).css, /url\("data:image\/png;base64,/);
  assert.equal(checkPackage(readZip(writeZip(packageFiles(ok)))).hash, ok.hash, 'download → upload gives the same theme');
});

test('built-in themes bundle is up to date', () => {
  execFileSync(process.execPath, ['scripts/bundle-themes.mjs', '--check'], { stdio: 'pipe' });
});
