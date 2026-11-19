// Customer storefront: store picker → the store's theme (layout + product cards) → ticket (cart + checkout) → order status.
// Themes only provide HTML templates and CSS (see THEMES.md). Everything that acts is here, wired through data-action attributes.
(() => {
  const { api, esc, money, $, $$, toast, store: ls, applyTheme } = SO;
  const S = { slug: null, hostMode: false, info: null, menu: [], cart: {}, quote: null, mode: 'delivery', loc: null, tsToken: null, tsWidget: null, coupon: '', reviews: null,
              pkg: null, values: {}, ctx: null, filter: { q: '', cat: null }, preview: false, themeParam: null };
  const app = $('#app'), sheetRoot = $('#sheet-root');
  const adminToken = () => { const a = ls.get('admin'); return S.preview && a && a.slug === S.slug ? a.token : null; };
  const T = () => ({ ...(S.hostMode ? {} : { tenant: S.slug }), token: adminToken() || (ls.get('b2b.' + S.slug) || {}).token });
  const PM_LABEL = { midtrans: ['Pay online', 'QRIS, e-wallet, virtual account or card'], doku: ['Pay online', 'QRIS, e-wallet, virtual account or card'], manual: ['Bank transfer', 'Transfer, then the store confirms your payment'] };
  const STEPS = [['pending_payment', 'Order placed'], ['paid', 'Payment received'], ['preparing', 'Being prepared'], ['shipped', 'On the way'], ['delivered', 'Delivered']];
  const smooth = () => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

  // ── boot ──
  async function boot() {
    const q = new URLSearchParams(location.search);
    const m = location.pathname.match(/^\/order\/([A-Z0-9]+)/i);
    S.preview = q.get('preview') === '1';
    S.themeParam = /^[\w-]{1,40}$/.test(q.get('theme') || '') ? q.get('theme') : null;
    S.slug = (q.get('store') || (S.preview ? '' : ls.get('store')) || '').toLowerCase() || null;
    bindTheme();
    if (S.preview) window.addEventListener('message', e => {
      if (e.origin !== location.origin || !e.data || e.data.type !== 'so-theme' || !S.pkg) return;
      S.values = { ...S.values, ...e.data.values }; applyTheme(S.values);
      const y = scrollY; renderShop(); scrollTo(0, y);
    });
    if (!S.slug) {
      try { S.info = await api('GET', '/api/store'); S.hostMode = true; S.slug = S.info.store.slug; }
      catch { return showPicker(); }
    }
    try { await enterStore(S.slug, !S.hostMode && !S.preview); }
    catch (e) { if (e.code === 'no_store') { ls.set('store', null); return showPicker("That store isn't available right now."); } return fatal(e); }
    if (m) { const mine = (ls.get('orders') || []).find(o => o.no === m[1].toUpperCase()); showOrder(m[1].toUpperCase(), mine?.phone); }
  }
  function fatal(e) { app.innerHTML = `<div class="wrap empty"><p>${esc(e.message)}</p><button class="btn" id="retry">Try again</button></div>`; $('#retry').onclick = () => location.reload(); }

  // ── store picker (one shared app for every store) ──
  async function showPicker(msg) {
    setThemeCss('');
    applyTheme({ primary: '#1F6F4A', accent: '#FFD23F', background: '#F3F7F2', surface: '#FFFFFF', text: '#13241B', radius: 14, font: 'Plus Jakarta Sans', mode: 'light' });
    document.title = 'Choose a store';
    app.innerHTML = `<main class="wrap picker"><h1>Where are you ordering from?</h1><p class="muted">${esc(msg || 'Pick a store. You can switch any time.')}</p><div class="store-list" id="stores"><span class="spinner"></span></div></main>`;
    try {
      const { stores } = await api('GET', '/api/directory');
      $('#stores').innerHTML = stores.length ? stores.map(s => `
        <button class="store-tile" data-slug="${esc(s.slug)}" style="--tile-bg:${esc(s.background)};--tile-primary:${esc(s.primary)};--tile-on:${SO.onColor(s.primary)};--tile-ink:${SO.onColor(s.background)}">
          <span class="mark">${s.logo ? `<img src="${esc(s.logo)}" alt="">` : esc(s.name.slice(0, 1))}</span>
          <span><b>${esc(s.name)}</b><span class="about">${esc(s.about || '')}</span></span></button>`).join('') : '<p class="muted">No stores are open yet.</p>';
      $$('.store-tile').forEach(b => (b.onclick = () => enterStore(b.dataset.slug, true).catch(fatal)));
    } catch (e) { $('#stores').innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
  }
  function switchStore() { ls.set('store', null); history.replaceState(null, '', '/'); S.pkg = null; showPicker(); }

  // ── theme package ──
  const pkgCache = {};
  async function loadPkg(path) { return (pkgCache[path] ||= api('GET', path).catch(e => { delete pkgCache[path]; throw e; })); }
  function setThemeCss(css) { let el = $('#theme-css'); if (!el) { el = document.createElement('style'); el.id = 'theme-css'; document.head.append(el); } el.textContent = css; }
  const defaultsOf = pkg => Object.fromEntries(pkg.settings.filter(x => x.id).map(x => [x.id, x.default]));
  // theme images can point at the theme's own pictures ("asset:hero.png")
  const imageUrl = u => (typeof u === 'string' && u.startsWith('asset:') ? S.pkg.assets[u.slice(6)] || '' : u || '');

  async function enterStore(slug, remember) {
    S.slug = slug;
    const [info, menu] = await Promise.all([S.hostMode && S.info ? S.info : api('GET', '/api/store', undefined, T()), api('GET', '/api/menu', undefined, T())]);
    S.info = info; S.menu = menu.products; S.quote = null; S.reviews = null; S.coupon = ''; S.filter = { q: '', cat: null };
    try { S.pkg = await loadPkg(S.themeParam ? `/api/themes/${S.themeParam}/package` : info.theme_pkg); }
    catch { S.pkg = await loadPkg('/api/themes/market/package'); }  // a missing theme never takes the shop down
    S.values = { ...defaultsOf(S.pkg), ...(S.preview && new URLSearchParams(location.search).get('defaults') === '1' ? {} : S.themeParam ? info.theme_saved : info.theme) };
    if (remember) ls.set('store', slug);
    S.cart = ls.get('cart.' + slug) || {};
    pruneCart();
    S.mode = 'delivery';
    applyTheme(S.values); setThemeCss(S.pkg.css); document.body.dataset.theme = S.pkg.ref;
    document.title = info.store.name;
    renderShop();
  }

  // ── menu data ──
  const variants = () => S.menu.flatMap(p => p.variants.map(v => ({ ...v, product: p })));
  const vById = id => variants().find(v => v.id === id);
  function pruneCart() { for (const id of Object.keys(S.cart)) { const v = vById(id); if (!v || v.available <= 0) delete S.cart[id]; else S.cart[id] = Math.min(S.cart[id], v.available); } saveCart(); }
  function saveCart() { ls.set('cart.' + S.slug, S.cart); }
  const cartCount = () => Object.values(S.cart).reduce((a, b) => a + b, 0);
  const cartTotal = () => Object.entries(S.cart).reduce((s, [id, q]) => s + (vById(id)?.price || 0) * q, 0);
  const inCart = p => p.variants.reduce((s, v) => s + (S.cart[v.id] || 0), 0);
  const productById = id => S.menu.find(p => p.id === id);

  // what a theme template can use (documented in THEMES.md)
  function cardCtx(p) {
    const prices = p.variants.map(v => v.price), lo = Math.min(...prices), left = p.variants.reduce((s, v) => s + Math.max(v.available, 0), 0), sold = left <= 0;
    return { id: p.id, name: p.name, description: p.description || '', image: p.image || '', initial: (p.name || '?').slice(0, 1).toUpperCase(), category: p.category || '',
      price: money(lo), from: prices.some(x => x !== lo), sold_out: sold, low: !sold && left <= 5, left, in_cart: inCart(p),
      rating: p.rating ? { avg: p.rating.avg.toFixed(1), count: p.rating.count, stars: '★'.repeat(Math.round(p.rating.avg)) + '☆'.repeat(5 - Math.round(p.rating.avg)) } : null,
      badge: sold ? 'Sold out' : left <= 5 ? `Only ${left} left` : null, variants: p.variants.map(v => ({ id: v.id, name: v.name, price: money(v.price), sold_out: v.available <= 0 })) };
  }
  function rootCtx() {
    const settings = {};
    for (const s of S.pkg.settings) if (s.id) settings[s.id] = s.type === 'image' ? imageUrl(S.values[s.id]) : S.values[s.id];
    for (const [k, v] of Object.entries(S.values)) if (!(k in settings)) settings[k] = v;
    const cats = [...new Set(S.menu.map(p => p.category || ''))], named = cats.filter(Boolean);
    const products = S.menu.map(cardCtx);
    return {
      store: { ...S.info.store, initial: S.info.store.name.slice(0, 1).toUpperCase(), logo: settings.logo || '' }, settings,
      categories: named.map(name => { const ps = S.menu.filter(p => p.category === name); return { name, count: ps.length, count_label: `${ps.length} item${ps.length === 1 ? '' : 's'}`, image: (ps.find(p => p.image) || {}).image || '', initial: name.slice(0, 1).toUpperCase() }; }),
      has_categories: named.length > 1,
      sections: cats.map(name => { const ps = products.filter(p => p.category === name); return { name, title: name || (named.length ? 'More' : 'All products'), count: ps.length, products: ps }; }),
      products, product_count: products.length, cart: { count: cartCount(), total: money(cartTotal()) }, can_switch: !S.hostMode && !S.preview, year: new Date().getFullYear()
    };
  }

  // ── the shop page, drawn by the theme ──
  function renderShop() {
    S.ctx = rootCtx();
    let frag;
    try { frag = TPL.clean(TPL.render(S.pkg.templates.layout, S.ctx, { card: S.pkg.templates.card })); }
    catch (e) { console.error(e); frag = TPL.clean(`<main class="wrap empty"><p>This store's design has a problem. Please try again later.</p></main>`); }
    app.replaceChildren(frag);
    app.insertAdjacentHTML('beforeend', `<div class="ticket-bar" id="tbar" hidden><button id="open-ticket"><span class="count" id="t-count"></span><span class="label">View order</span><span class="sum" id="t-sum"></span></button></div>`);
    $('#open-ticket').onclick = openTicket;
    applyFilter(); watchSections(); updateBar(false);
  }
  const cardNode = p => TPL.clean(TPL.render(S.pkg.templates.card, { ...S.ctx, ...cardCtx(p) })).firstElementChild;
  function refreshCards() {
    for (const el of $$('[data-card]', app)) {
      const p = productById(el.dataset.card); if (!p) continue;
      const focused = el.contains(document.activeElement) ? document.activeElement.dataset.action : null, next = cardNode(p);
      if (!next) continue;
      el.replaceWith(next);
      if (focused) $(`[data-action="${focused}"]`, next)?.focus({ preventScroll: true });
    }
  }
  function bindTheme() {
    app.addEventListener('click', e => {
      const el = e.target.closest('[data-action]');
      if (!el || !S.pkg || !app.contains(el) || el.matches('input')) return;
      const p = el.dataset.id ? productById(el.dataset.id) : null;
      switch (el.dataset.action) {
        case 'product': return openProduct(p);
        case 'quickview': return quickView(p);
        case 'add': return quickAdd(p);
        case 'cart': return openTicket();
        case 'orders': return showMyOrders();
        case 'stores': return switchStore();
        case 'category': return pickCategory(el.dataset.category);
        case 'all': S.filter = { q: '', cat: null }; clearSearch(); applyFilter(); return;
        case 'home': S.filter = { q: '', cat: null }; clearSearch(); applyFilter(); return scrollTo({ top: 0, behavior: smooth() });
        case 'scroll': return document.getElementById(el.dataset.target)?.scrollIntoView({ behavior: smooth() });
      }
    });
    app.addEventListener('input', e => { if (e.target.matches('input[data-action="search"]')) { S.filter = { q: e.target.value.trim(), cat: null }; applyFilter(); } });
    app.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('input[data-action="search"]')) { e.preventDefault(); $('[data-results]', app)?.scrollIntoView({ behavior: smooth(), block: 'start' }); } });
  }
  const clearSearch = () => $$('input[data-action="search"]', app).forEach(i => (i.value = ''));
  function pickCategory(cat) {
    if ($('[data-slot="results"]', app)) { S.filter = { q: '', cat }; clearSearch(); applyFilter(); const r = $('[data-results]', app); r && r.getBoundingClientRect().top < 0 && r.scrollIntoView({ behavior: smooth() }); return; }
    $(`[data-section="${CSS.escape(cat)}"]`, app)?.scrollIntoView({ behavior: smooth() });
  }
  // search and category filter: shown in the theme's results area (data-results / data-slot="results")
  function applyFilter() {
    const f = S.filter, on = !!(f.q || f.cat), slot = $('[data-slot="results"]', app);
    $$('[data-action="category"]', app).forEach(b => b.setAttribute('aria-pressed', String(!!f.cat && b.dataset.category === f.cat)));
    $$('[data-action="all"]', app).forEach(b => b.setAttribute('aria-pressed', String(!on)));
    if (!slot) return;
    $$('[data-home]', app).forEach(x => (x.hidden = on)); $$('[data-results]', app).forEach(x => (x.hidden = !on));
    if (!on) { slot.replaceChildren(); return; }
    const q = f.q.toLowerCase();
    const list = S.menu.filter(p => (!f.cat || (p.category || '') === f.cat) && (!q || [p.name, p.description, p.category, ...p.variants.map(v => v.name)].join(' ').toLowerCase().includes(q)));
    $$('[data-bind="results-title"]', app).forEach(x => (x.textContent = f.q ? `${list.length} result${list.length === 1 ? '' : 's'} for “${f.q}”` : f.cat));
    if (list.length) slot.replaceChildren(...list.map(cardNode).filter(Boolean));
    else slot.innerHTML = `<p class="so-empty">Nothing matches “${esc(f.q)}”. Try another word, or <button type="button" class="linkish" data-action="all">see everything</button>.</p>`;
  }
  let sectionWatch;
  function watchSections() {
    sectionWatch && sectionWatch.disconnect();
    if ($('[data-slot="results"]', app) || !$('[data-section]', app)) return;
    const chips = $$('[data-action="category"]', app);
    sectionWatch = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) chips.forEach(c => c.setAttribute('aria-pressed', String(c.dataset.category === e.target.dataset.section))); }), { rootMargin: '-40% 0px -55% 0px' });
    $$('[data-section]', app).forEach(s => sectionWatch.observe(s));
  }
  function updateBar(bump = true) {
    const n = cartCount(), total = money(cartTotal()), bar = $('#tbar');
    document.body.dataset.cart = n ? 'full' : 'empty';
    if (S.ctx) S.ctx.cart = { count: n, total };
    $$('[data-bind="cart-count"]', app).forEach(x => (x.textContent = n));
    $$('[data-bind="cart-total"]', app).forEach(x => (x.textContent = total));
    if (bar) {
      bar.hidden = n === 0;
      $('#t-count').textContent = n; $('#t-sum').textContent = total;
      if (bump) { bar.classList.remove('bump'); void bar.offsetWidth; bar.classList.add('bump'); }
    }
    refreshCards();
  }
  function addToCart(p, id, qty) { S.cart[id] = (S.cart[id] || 0) + qty; saveCart(); S.quote = null; updateBar(); toast(`Added ${p.name}`); }
  // the round + on a card: one option → straight in; several → quick view
  function quickAdd(p) {
    if (!p) return;
    const open = p.variants.filter(v => v.available - (S.cart[v.id] || 0) > 0);
    if (p.variants.length > 1) return quickView(p);
    if (!open.length) return toast(p.variants.some(v => v.available > 0) ? 'All available units are in your order' : 'Sold out for now');
    addToCart(p, open[0].id, 1);
  }

  // ── sheets ──
  function openSheet(html, onClose, cls = '') {
    sheetRoot.innerHTML = `<div class="scrim"></div><div class="sheet ${cls}" role="dialog" aria-modal="true"><div class="inner"><div class="grab" aria-hidden="true"></div>${html}</div></div>`;
    const back = document.activeElement;
    const close = () => { document.body.classList.remove('sheet-in'); setTimeout(() => { sheetRoot.innerHTML = ''; back && back.isConnected && back.focus({ preventScroll: true }); onClose && onClose(); }, 260); document.removeEventListener('keydown', esc_); };
    const esc_ = e => { if (e.key === 'Escape') close(); };
    $('.scrim', sheetRoot).onclick = close; document.addEventListener('keydown', esc_);
    const t = $('h2', sheetRoot); if (t) { t.id ||= 'sheet-title'; $('.sheet', sheetRoot).setAttribute('aria-labelledby', t.id); }
    requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.add('sheet-in')));
    const first = $('button, input', $('.sheet', sheetRoot)); first && first.focus({ preventScroll: true });
    return close;
  }

  // quick view: photo, options, quantity and add, without leaving the shelf
  function quickView(p) {
    if (!p) return;
    const sel = { id: (p.variants.find(v => v.available > 0) || p.variants[0]).id, qty: 1 };
    const v = () => p.variants.find(x => x.id === sel.id);
    let after = null;
    const close = openSheet(`
      <button class="close-x" aria-label="Close">×</button>
      <div class="qv">
        <div class="qv-media">${p.image ? `<img src="${esc(p.image)}" alt="">` : `<span aria-hidden="true">${esc(p.name.slice(0, 1))}</span>`}</div>
        <div class="qv-info">
          ${p.category ? `<p class="qv-cat">${esc(p.category)}</p>` : ''}
          <h2 id="qv-title">${esc(p.name)}</h2>
          ${p.rating ? `<p class="stars">★ ${p.rating.avg.toFixed(1)} <span class="muted">(${p.rating.count} rating${p.rating.count === 1 ? '' : 's'})</span></p>` : ''}
          <p class="qv-price" id="qv-price"></p>
          ${p.description ? `<p class="qv-desc">${esc(p.description)}</p>` : ''}
          ${p.variants.length > 1 ? `<div class="section-title" id="qv-opt">Choose one</div><div class="qv-vars" role="radiogroup" aria-labelledby="qv-opt">${p.variants.map(x => `
            <button type="button" role="radio" aria-checked="false" data-v="${esc(x.id)}" ${x.available <= 0 ? 'disabled' : ''}><b>${esc(x.name)}</b><span>${x.available <= 0 ? 'Sold out' : money(x.price)}</span></button>`).join('')}</div>` : ''}
          <div class="qv-buy"><div class="stepper"><button id="qm" aria-label="Fewer">−</button><output id="qq" aria-live="polite">1</output><button id="qp" aria-label="More">+</button></div><button class="btn" id="qv-add"></button></div>
          <p class="note" id="qv-note"></p>
          <button class="linkish qv-more" id="qv-more">See full details${p.rating ? ' and reviews' : ''}</button>
        </div>
      </div>`, () => after && after(), 'wide');
    const sync = () => {
      const x = v(), room = x.available - (S.cart[x.id] || 0);
      sel.qty = Math.max(1, Math.min(sel.qty, Math.max(room, 1)));
      $('#qv-price').textContent = money(x.price * sel.qty);
      $('#qq').value = sel.qty; $('#qm').disabled = sel.qty <= 1; $('#qp').disabled = sel.qty >= room;
      $$('.qv-vars button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.v === sel.id)));
      const btn = $('#qv-add'); btn.disabled = room <= 0;
      btn.textContent = x.available <= 0 ? 'Sold out for now' : room <= 0 ? 'All available units are in your order' : 'Add to order';
      $('#qv-note').textContent = x.available > 0 && x.available <= 5 ? `Only ${x.available} left` : S.cart[x.id] ? `${S.cart[x.id]} already in your order` : '';
    };
    $$('.qv-vars button').forEach(b => (b.onclick = () => { sel.id = b.dataset.v; sel.qty = 1; sync(); }));
    $('#qm').onclick = () => { sel.qty--; sync(); }; $('#qp').onclick = () => { sel.qty++; sync(); };
    $('.close-x', sheetRoot).onclick = close;
    $('#qv-add').onclick = () => { addToCart(p, sel.id, sel.qty); close(); };
    $('#qv-more').onclick = () => { after = () => openProduct(p); close(); };
    sync();
  }

  function openProduct(p) {
    if (!p) return;
    if (p.variants.every(v => v.available <= 0)) return quickView(p);
    const sel = { id: (p.variants.find(v => v.available > 0) || {}).id, qty: 1 };
    const v = () => p.variants.find(x => x.id === sel.id);
    const close = openSheet(`
      <button class="close-x" aria-label="Close">×</button>
      ${p.image ? `<img class="hero-img" src="${esc(p.image)}" alt="">` : ''}
      <h2>${esc(p.name)}</h2>${p.description ? `<p class="muted">${esc(p.description)}</p>` : ''}
      ${p.variants.length > 1 ? `<div class="section-title">Choose one</div><div class="options">${p.variants.map(x => `
        <label class="opt"><input type="radio" name="v" value="${esc(x.id)}" ${x.id === sel.id ? 'checked' : ''} ${x.available <= 0 ? 'disabled' : ''}>
        <span>${esc(x.name)}${x.available <= 0 ? '<small>Sold out</small>' : x.available <= 5 ? `<small>Only ${x.available} left</small>` : ''}</span><span class="fee">${money(x.price)}</span></label>`).join('')}</div>` : ''}
      <div class="section-title">How many?</div>
      <div class="stepper"><button id="pm" aria-label="Fewer">−</button><output id="pq">1</output><button id="pp" aria-label="More">+</button></div>
      <button class="btn" id="add"></button>
      <div id="p-reviews"></div>`);
    const sync = () => { const a = v().available - (S.cart[sel.id] || 0); sel.qty = Math.max(1, Math.min(sel.qty, Math.max(a, 1))); $('#pq').value = sel.qty; $('#pm').disabled = sel.qty <= 1; $('#pp').disabled = sel.qty >= a; $('#add').disabled = a <= 0; $('#add').textContent = a <= 0 ? 'All available units are in your order' : `Add to order – ${money(v().price * sel.qty)}`; };
    $$('input[name=v]').forEach(r => (r.onchange = () => { sel.id = r.value; sync(); }));
    $('#pm').onclick = () => { sel.qty--; sync(); }; $('#pp').onclick = () => { sel.qty++; sync(); };
    $('.close-x', sheetRoot).onclick = close;
    $('#add').onclick = () => { addToCart(p, sel.id, sel.qty); close(); };
    sync();
    if (p.rating) loadReviews().then(all => {
      const mine = all.filter(r => r.product_id === p.id).slice(0, 4), box = $('#p-reviews'); if (!box || !mine.length) return;
      box.innerHTML = `<div class="section-title">What people say</div>` + mine.map(r => `<div class="review"><span class="stars">${'★'.repeat(r.stars)}</span> <b>${esc(r.name)}</b>${r.text ? `<p>${esc(r.text)}</p>` : ''}</div>`).join('');
    }).catch(() => {});
  }
  async function loadReviews() { if (!S.reviews) S.reviews = (await api('GET', '/api/reviews', undefined, T())).reviews; return S.reviews; }

  // ── the ticket: cart + checkout in one sheet ──
  function openTicket() {
    const me = ls.get('me') || {};
    S.tsToken = null;
    const pays = S.info.payments, twoOnline = pays.includes('midtrans') && pays.includes('doku');
    const close = openSheet(`
      <button class="close-x" aria-label="Close">×</button>
      <h2>Your order</h2><p class="muted">${esc(S.info.store.name)}</p>
      ${(ls.get('b2b.' + S.slug) || {}).name ? `<p class="note">Business pricing for ${esc(ls.get('b2b.' + S.slug).name)}</p>` : ''}
      <div class="receipt"><div id="lines"></div><div class="totals" id="totals"></div></div>
      <div class="field"><label for="c-coupon">Coupon code</label><div class="inline"><input id="c-coupon" autocapitalize="characters" autocomplete="off" maxlength="16" value="${esc(S.coupon)}"><button type="button" class="btn ghost small" id="c-apply">Apply</button></div></div>
      <div id="c-msg" class="note" aria-live="polite"></div>
      ${S.info.pickup ? `<div class="seg" role="group" aria-label="How do you want it?"><button data-mode="delivery">Delivery</button><button data-mode="pickup">Pick up</button></div>` : ''}
      <div class="section-title">Your details</div>
      <div class="row2"><div class="field"><label for="c-name">Name</label><input id="c-name" autocomplete="name" value="${esc(me.name || '')}"></div>
      <div class="field"><label for="c-phone">WhatsApp number</label><input id="c-phone" inputmode="tel" autocomplete="tel" value="${esc(me.phone || '')}"></div></div>
      <div id="addr">
        <div class="field"><label for="c-addr">Delivery address</label><textarea id="c-addr" rows="2" autocomplete="street-address">${esc(me.address || '')}</textarea></div>
        <div class="row2"><div class="field"><label for="c-zip">Postal code</label><input id="c-zip" inputmode="numeric" maxlength="5" autocomplete="postal-code" value="${esc(me.zip || '')}"></div>
        <div class="field"><label for="c-note">Note for the courier</label><input id="c-note" placeholder="Gate colour, landmark…" value=""></div></div>
      </div>
      <button class="loc-btn" id="loc"></button>
      <div class="section-title" id="opt-title">Delivery</div>
      <div id="opts"><button class="btn ghost" id="get-opts">Show delivery options</button></div>
      <div class="section-title">Payment</div>
      <div class="options">${pays.map((p, i) => `<label class="opt"><input type="radio" name="pay" value="${p}" ${i === 0 ? 'checked' : ''}>
        <span>${PM_LABEL[p][0]}${twoOnline && p !== 'manual' ? ` (${p === 'doku' ? 'DOKU' : 'Midtrans'})` : ''}<small>${PM_LABEL[p][1]}</small></span><span></span></label>`).join('') || '<p class="muted">This store has no payment method set up yet.</p>'}</div>
      ${S.info.turnstile_site_key ? '<div class="ts" id="ts"></div>' : ''}
      <div id="err"></div>
      <button class="btn" id="place" disabled>Place order</button>
      <p class="note">Prices are checked again when you place the order.</p>`, () => { S.tsWidget = null; });
    $('.close-x', sheetRoot).onclick = close;
    me.loc && (S.loc = me.loc);
    $$('.seg button').forEach(b => (b.onclick = () => { S.mode = b.dataset.mode; S.quote = null; syncMode(); }));
    $('#loc').onclick = locate;
    $('#c-apply').onclick = () => {
      S.coupon = $('#c-coupon').value.trim().toUpperCase(); const d = destination();
      if (S.mode === 'pickup' || (d.address && (S.loc || /^\d{5}$/.test(d.postal_code || '')))) getOptions(); else renderTotals();
    };
    $('#get-opts').onclick = getOptions;
    ['#c-addr', '#c-zip'].forEach(s => $(s).addEventListener('change', () => { S.quote = null; renderOptions(); }));
    $('#place').onclick = place;
    if (S.info.turnstile_site_key) mountTurnstile();
    renderLines(); syncMode();
  }
  function syncMode() {
    $$('.seg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === S.mode)));
    $('#addr').hidden = S.mode === 'pickup';
    $('#opt-title').textContent = S.mode === 'pickup' ? 'Pick up from' : 'Delivery';
    $('#get-opts').textContent = S.mode === 'pickup' ? 'Find the nearest store' : 'Show delivery options';
    locLabel(); renderOptions();
  }
  function locLabel() { const b = $('#loc'); if (!b) return; b.classList.toggle('set', !!S.loc); b.textContent = S.loc ? 'Location set – tap to update' : S.mode === 'pickup' ? 'Use my location to find the nearest store' : 'Use my location (needed for store couriers)'; }
  function locate() {
    if (!navigator.geolocation) return toast("This device can't share its location");
    $('#loc').textContent = 'Finding you…';
    navigator.geolocation.getCurrentPosition(p => { S.loc = { lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6) }; S.quote = null; locLabel(); renderOptions(); },
      () => { locLabel(); toast('Location is off. Turn it on, or type your postal code.'); }, { enableHighAccuracy: true, timeout: 12000 });
  }
  function renderLines() {
    const ids = Object.keys(S.cart);
    if (!ids.length) { $('#lines').innerHTML = '<p class="muted">Your order is empty.</p>'; $('#totals').innerHTML = ''; return; }
    $('#lines').innerHTML = ids.map(id => { const v = vById(id), q = S.cart[id], label = v.name && v.name !== v.product.name ? `${v.product.name} – ${v.name}` : v.product.name; return `
      <div class="line"><div><div class="name">${esc(label)}</div><div class="each">${money(v.price)} each</div></div>
      <div class="stepper" data-id="${esc(id)}"><button data-d="-1" aria-label="Fewer ${esc(label)}">−</button><output>${q}</output><button data-d="1" aria-label="More ${esc(label)}" ${q >= v.available ? 'disabled' : ''}>+</button></div></div>`; }).join('');
    $$('#lines .stepper button').forEach(b => (b.onclick = () => {
      const id = b.closest('.stepper').dataset.id; S.cart[id] += +b.dataset.d; if (S.cart[id] <= 0) delete S.cart[id];
      saveCart(); S.quote = null; renderLines(); renderOptions(); updateBar(false);
    }));
    renderTotals();
  }
  function renderTotals() {
    const ship = chosenShip(), sub = cartTotal(), pr = S.quote?.pricing || {}, td = pr.tier_discount || 0, cd = pr.coupon_discount || 0, badCoupon = !!(S.coupon && pr.coupon_error);
    const total = sub - td - cd + (ship?.fee || 0);
    $('#totals').innerHTML = `<div><span>Items</span><span>${money(sub)}</span></div>
      ${td ? `<div><span>${pr.business ? 'Business discount' : 'Volume discount'}</span><span>−${money(td)}</span></div>` : ''}
      ${cd ? `<div><span>Coupon ${esc(pr.coupon)}</span><span>−${money(cd)}</span></div>` : ''}
      <div><span>${S.mode === 'pickup' ? 'Pick up' : 'Delivery'}</span><span>${ship ? (ship.fee ? money(ship.fee) : 'Free') : '–'}</span></div>
      <div class="grand"><span>Total</span><span>${money(total)}</span></div>`;
    const m = $('#c-msg');
    if (m) { m.className = 'note'; m.textContent = !S.coupon ? '' : !S.quote ? 'Your code is checked when you choose delivery.' : pr.coupon_error ? pr.coupon_error : `${pr.coupon} applied`; if (S.coupon && pr.coupon_error) m.className = 'note bad'; }
    const ok = cartCount() > 0 && ship && !badCoupon && S.info.payments.length && (!S.info.turnstile_site_key || S.tsToken);
    const btn = $('#place'); btn.disabled = !ok; btn.textContent = ship ? `Place order – ${money(total)}` : 'Place order';
  }
  const chosenShip = () => { const r = $('input[name=ship]:checked'); return r && S.quote ? S.quote.options.find(o => o.id === r.value) : null; };
  function destination() {
    return { address: $('#c-addr')?.value.trim(), postal_code: $('#c-zip')?.value.trim(), note: $('#c-note')?.value.trim(), ...(S.loc || {}) };
  }
  async function getOptions() {
    if (!cartCount()) return;
    const d = destination();
    if (S.mode === 'delivery' && !d.address) { $('#c-addr').focus(); return toast('Add your delivery address first'); }
    if (S.mode === 'delivery' && !S.loc && !/^\d{5}$/.test(d.postal_code || '')) { $('#c-zip').focus(); return toast('Add your postal code or use your location'); }
    $('#opts').innerHTML = '<span class="spinner"></span>';
    try {
      S.quote = await api('POST', '/api/quote', { items: lines(), destination: d, pickup: S.mode === 'pickup', coupon: S.coupon || undefined }, T());
      S.quote.options = S.quote.options.filter(o => (o.provider === 'pickup') === (S.mode === 'pickup'));
      renderOptions();
    } catch (e) { S.quote = null; renderOptions(e.message); }
  }
  function renderOptions(err) {
    const box = $('#opts'); if (!box) return;
    if (!S.quote) {
      box.innerHTML = `${err ? `<div class="error-box">${esc(err)}</div>` : ''}<button class="btn ghost" id="get-opts">${S.mode === 'pickup' ? 'Find the nearest store' : 'Show delivery options'}</button>`;
      $('#get-opts').onclick = getOptions; renderTotals(); return;
    }
    const o = S.quote.options;
    box.innerHTML = o.length ? `<p class="note">Ships from ${esc(S.quote.warehouse.name)}${S.quote.distance_km != null ? `, about ${S.quote.distance_km} km away` : ''}.</p>
      <div class="options">${o.map((x, i) => `<label class="opt"><input type="radio" name="ship" value="${esc(x.id)}" ${i === 0 ? 'checked' : ''}><span>${esc(x.label)}${x.eta ? `<small>${esc(x.eta)}</small>` : ''}</span><span class="fee">${x.fee ? money(x.fee) : 'Free'}</span></label>`).join('')}</div>`
      : `<div class="error-box">${S.mode === 'pickup' ? 'Pick up isn\'t available for this order.' : 'No delivery option reaches this address. Try pick up, or check the address.'}</div>`;
    $$('input[name=ship]').forEach(r => (r.onchange = renderTotals));
    renderTotals();
  }
  const lines = () => Object.entries(S.cart).map(([variant_id, qty]) => ({ variant_id, qty }));

  function mountTurnstile() {
    const go = () => { S.tsWidget = window.turnstile.render('#ts', { sitekey: S.info.turnstile_site_key, callback: t => { S.tsToken = t; renderTotals(); }, 'expired-callback': () => { S.tsToken = null; renderTotals(); } }); };
    if (window.turnstile) return go();
    window.__tsReady = go;
    if (!$('#ts-script')) { const s = document.createElement('script'); s.id = 'ts-script'; s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=__tsReady&render=explicit'; s.async = true; document.head.append(s); }
  }

  async function place() {
    const name = $('#c-name').value.trim(), phone = $('#c-phone').value.trim(), ship = chosenShip(), pay = $('input[name=pay]:checked')?.value;
    $('#err').innerHTML = '';
    if (!name) { $('#c-name').focus(); return toast('Add your name'); }
    if (phone.replace(/\D/g, '').length < 8) { $('#c-phone').focus(); return toast('Add a WhatsApp number we can reach'); }
    const d = destination();
    ls.set('me', { name, phone, address: d.address || ls.get('me')?.address, zip: d.postal_code || ls.get('me')?.zip, loc: S.loc });
    const btn = $('#place'); btn.disabled = true; btn.textContent = 'Placing your order…';
    try {
      const r = await api('POST', '/api/checkout', { items: lines(), customer: { name, phone }, destination: d, shipping_id: ship.id,
        pickup_warehouse_id: S.mode === 'pickup' ? S.quote.warehouse.id : undefined, payment: pay, turnstile: S.tsToken, coupon: S.coupon || undefined }, T());
      const mine = ls.get('orders') || []; mine.unshift({ no: r.order.no, phone, slug: S.slug, at: Date.now() }); ls.set('orders', mine.slice(0, 30));
      S.cart = {}; saveCart(); S.quote = null; S.coupon = '';
      if (r.order.payment.url) { location.href = r.order.payment.url; return; }
      document.body.classList.remove('sheet-in'); sheetRoot.innerHTML = '';
      showOrder(r.order.no, phone, r);
    } catch (e) {
      if (S.tsWidget != null && window.turnstile) { window.turnstile.reset(S.tsWidget); S.tsToken = null; }
      if (['out_of_stock', 'shipping_changed', 'unavailable'].includes(e.code)) { S.quote = null; try { S.menu = (await api('GET', '/api/menu', undefined, T())).products; pruneCart(); renderLines(); updateBar(false); } catch {} renderOptions(); }
      $('#err').innerHTML = `<div class="error-box">${esc(e.message)}</div>`;
      renderTotals();
    }
  }

  // ── order status ──
  async function showOrder(no, phone, fresh) {
    const href = `/order/${no}${S.hostMode ? '' : `?store=${S.slug}`}`; if (location.pathname + location.search !== href) history.pushState(null, '', href);
    window.scrollTo(0, 0);
    app.innerHTML = `<header class="top"><div class="wrap bar"><button class="icon-btn" id="back">‹ Menu</button><h1>Order ${esc(no)}</h1></div></header>
      <main class="wrap status-page" id="st"><span class="spinner"></span></main>`;
    $('#back').onclick = () => { history.pushState(null, '', S.hostMode ? '/' : `/?store=${S.slug}`); renderShop(); };
    if (!phone) return askPhone(no);
    try {
      const { order: o } = fresh || await api('GET', `/api/order?no=${encodeURIComponent(no)}&phone=${encodeURIComponent(phone)}`, undefined, T());
      const manual = fresh?.manual || (o.payment.provider === 'manual' ? S.info.manual : null);
      const pickup = /^Pick up/.test(o.shipping.label);
      const steps = STEPS.map(([k, label]) => [k, k === 'delivered' && pickup ? 'Picked up' : k === 'shipped' && pickup ? 'Ready to pick up' : label]);
      const at = steps.findIndex(([k]) => k === o.status);
      const dead = o.status === 'cancelled' || o.status === 'expired';
      $('#st').innerHTML = `
        <h2>${dead ? (o.status === 'expired' ? 'Payment time ran out' : 'Order cancelled') : o.status === 'pending_payment' ? 'Waiting for payment' : o.status === 'delivered' ? 'Enjoy!' : 'Thanks, we\'re on it'}</h2>
        <p class="muted">${dead ? 'Nothing was charged for this order. You can order again from the menu.' : o.status === 'pending_payment' && o.expires_at ? `Pay before ${new Date(o.expires_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} to keep your items.` : esc(o.shipping.label) + (o.shipping.waybill ? `, tracking number ${esc(o.shipping.waybill)}` : '')}</p>
        ${o.payment.url ? `<a class="btn" href="${esc(o.payment.url)}">Pay ${money(o.total)}</a>` : ''}
        ${manual && o.status === 'pending_payment' ? `<div class="bank"><div class="muted">Transfer exactly ${money(o.total)} to</div><div class="acct">${esc(manual.account_no || '')}</div><div>${esc(manual.bank || '')}${manual.account_name ? `, ${esc(manual.account_name)}` : ''}</div>${manual.note ? `<p class="note">${esc(manual.note)}</p>` : ''}</div>` : ''}
        ${dead ? '' : `<ol class="steps">${steps.map(([k, l], i) => `<li class="${i <= at ? 'done' : ''}"><b>${esc(l)}</b></li>`).join('')}</ol>`}
        <div class="receipt">${o.items.map(i => `<div class="line"><div><div class="name">${esc(i.label)}</div><div class="each">${i.qty} × ${money(i.price)}</div></div><b>${money(i.price * i.qty)}</b></div>`).join('')}
          <div class="totals"><div><span>Items</span><span>${money(o.subtotal)}</span></div>${o.tier_discount ? `<div><span>Discount</span><span>−${money(o.tier_discount)}</span></div>` : ''}${o.coupon_discount ? `<div><span>Coupon ${esc(o.coupon_code)}</span><span>−${money(o.coupon_discount)}</span></div>` : ''}<div><span>${esc(o.shipping.label)}</span><span>${o.shipping_fee ? money(o.shipping_fee) : 'Free'}</span></div><div class="grand"><span>Total</span><span>${money(o.total)}</span></div></div></div>
        ${feedbackHtml(o)}
        ${S.info.store.whatsapp ? `<a class="btn ghost" href="https://wa.me/${esc(S.info.store.whatsapp)}?text=${encodeURIComponent('Hi, about order ' + o.no)}" target="_blank" rel="noopener">Message the store</a>` : ''}
        <button class="btn ghost" id="refresh">Check status again</button>`;
      $('#refresh').onclick = () => showOrder(no, phone);
      bindFeedback(o, no, phone);
    } catch (e) { $('#st').innerHTML = `<div class="error-box">${esc(e.message)}</div>`; }
  }
  function askPhone(no) {
    $('#st').innerHTML = `<h2>Find order ${esc(no)}</h2><p class="muted">Enter the WhatsApp number you ordered with.</p>
      <div class="field"><label for="fp">WhatsApp number</label><input id="fp" inputmode="tel"></div><button class="btn" id="find">Find my order</button>`;
    $('#find').onclick = () => showOrder(no, $('#fp').value.trim());
  }
  function showMyOrders() {
    const mine = (ls.get('orders') || []).filter(o => o.slug === S.slug);
    const close = openSheet(`<button class="close-x" aria-label="Close">×</button><h2>My orders</h2>
      ${mine.length ? `<div class="orders-list">${mine.map(o => `<button class="order-link" data-no="${esc(o.no)}" data-phone="${esc(o.phone)}"><b>${esc(o.no)}</b><span class="muted">${new Date(o.at).toLocaleDateString([], { day: 'numeric', month: 'short' })}</span></button>`).join('')}</div>`
        : '<p class="muted">Orders you place on this phone show up here.</p>'}
      <div class="section-title">Business account</div>
      ${(ls.get('b2b.' + S.slug) || {}).name ? `<p>Business pricing is on for <b>${esc(ls.get('b2b.' + S.slug).name)}</b>.</p><button class="btn ghost" id="biz-out">Log out</button>`
        : `<div class="row2"><div class="field"><label for="bl">Username</label><input id="bl" autocapitalize="none" autocomplete="username"></div><div class="field"><label for="bp">Password</label><input id="bp" type="password" autocomplete="current-password"></div></div><button class="btn ghost" id="biz-in">Log in</button><p class="note">For shops and cafes with a business account from this store.</p>`}
      <div class="section-title">Ordered on another phone?</div>
      <div class="row2"><div class="field"><label for="on">Order number</label><input id="on" autocapitalize="characters"></div><div class="field"><label for="op">WhatsApp number</label><input id="op" inputmode="tel"></div></div>
      <button class="btn ghost" id="lookup">Find order</button>`);
    $('.close-x', sheetRoot).onclick = close;
    if ($('#biz-out')) $('#biz-out').onclick = () => { ls.set('b2b.' + S.slug, null); S.quote = null; close(); toast('Logged out of your business account'); };
    if ($('#biz-in')) $('#biz-in').onclick = async e => {
      const btn = e.target; btn.disabled = true;
      try { const r = await api('POST', '/api/b2b/login', { login: $('#bl').value.trim(), password: $('#bp').value }, T()); ls.set('b2b.' + S.slug, { token: r.token, name: r.account.name }); S.quote = null; close(); toast(`Business pricing on for ${r.account.name}`); }
      catch (err) { toast(err.message); btn.disabled = false; }
    };
    $$('.order-link').forEach(b => (b.onclick = () => { close(); showOrder(b.dataset.no, b.dataset.phone); }));
    $('#lookup').onclick = () => { const no = $('#on').value.trim().toUpperCase(); if (no) { close(); showOrder(no, $('#op').value.trim()); } };
  }
  // ── reviews and complaints (after delivery) ──
  const REASONS = ['Damaged item', 'Wrong item', 'Missing item', 'Quality problem', 'Other'];
  function feedbackHtml(o) {
    if (o.status !== 'delivered') return '';
    const seen = o.reviewed || [], todo = o.items.filter(i => i.product_id && !seen.includes(i.product_id)), done = o.items.filter(i => seen.includes(i.product_id));
    return `<div class="section-title">How was it?</div>
      ${todo.map(i => `<div class="rate" data-pid="${esc(i.product_id)}"><b>${esc(i.label)}</b>
        <div class="starpick" role="radiogroup" aria-label="Rating for ${esc(i.label)}">${[1, 2, 3, 4, 5].map(n => `<button type="button" role="radio" aria-checked="false" data-n="${n}" aria-label="${n} star${n > 1 ? 's' : ''}">★</button>`).join('')}</div>
        <div class="field"><input maxlength="200" placeholder="Say a little about it (optional)" aria-label="Comment on ${esc(i.label)}"></div>
        <button type="button" class="btn ghost small" data-send>Send rating</button></div>`).join('')}
      ${done.length ? `<p class="note">Thanks for rating ${done.map(i => esc(i.label)).join(', ')}.</p>` : ''}
      ${o.complaint ? `<div class="bank"><b>Your report: ${{ open: 'we received it', resolved: 'resolved', rejected: 'closed' }[o.complaint.status]}</b>${o.complaint.note ? `<p class="note">${esc(o.complaint.note)}</p>` : ''}</div>`
        : o.can_complain ? `<button class="btn ghost" id="report">Report a problem</button><p class="note">You can report a problem until ${new Date(o.complain_until).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}.</p>`
        : '<p class="note">The time to report a problem has ended.</p>'}`;
  }
  function bindFeedback(o, no, phone) {
    $$('.rate').forEach(box => {
      let stars = 0;
      $$('.starpick button', box).forEach(b => (b.onclick = () => { stars = +b.dataset.n; $$('.starpick button', box).forEach(x => { x.classList.toggle('on', +x.dataset.n <= stars); x.setAttribute('aria-checked', String(+x.dataset.n === stars)); }); }));
      $('[data-send]', box).onclick = async e => {
        if (!stars) return toast('Tap the stars first');
        const btn = e.target; btn.disabled = true;
        try { await api('POST', '/api/review', { no, phone, product_id: box.dataset.pid, stars, text: $('input', box).value.trim() }, T()); toast('Thanks for your rating'); S.reviews = null; showOrder(no, phone); }
        catch (err) { toast(err.message); btn.disabled = false; }
      };
    });
    if ($('#report')) $('#report').onclick = () => reportSheet(o, no, phone);
  }
  // photos are shrunk on the phone so they upload fast (the server accepts up to ~250 KB each)
  async function shrink(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("We can't read that photo. Try another one.")); i.src = url; });
      let max = 1000, q = 0.72;
      for (let n = 0; n < 6; n++) {
        const k = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        const out = c.toDataURL('image/jpeg', q); if (out.length <= 250000) return out;
        max *= 0.8; q = Math.max(0.4, q - 0.08);
      }
      throw new Error('That photo is too large. Try another one.');
    } finally { URL.revokeObjectURL(url); }
  }
  function reportSheet(o, no, phone) {
    let imgs = [];
    const close = openSheet(`<button class="close-x" aria-label="Close">×</button><h2>Report a problem</h2><p class="muted">Order ${esc(no)}</p>
      <div class="field"><label for="r-reason">What went wrong?</label><select id="r-reason">${REASONS.map(r => `<option>${r}</option>`).join('')}</select></div>
      <div class="field"><label for="r-item">Which item?</label><select id="r-item"><option value="">The whole order</option>${o.items.map(i => `<option>${esc(i.label)}</option>`).join('')}</select></div>
      <div class="field"><label for="r-text">Tell us what happened</label><textarea id="r-text" rows="3" maxlength="400"></textarea></div>
      <div class="field"><label for="r-photos">Photos, 1 to 3</label><input id="r-photos" type="file" accept="image/*" multiple></div>
      <div id="r-prev" class="note"></div><div id="r-err"></div>
      <button class="btn" id="r-send">Send report</button>`);
    $('.close-x', sheetRoot).onclick = close;
    $('#r-photos').onchange = async e => {
      imgs = []; $('#r-prev').textContent = 'Preparing photos…';
      try { for (const f of [...e.target.files].slice(0, 3)) imgs.push(await shrink(f)); $('#r-prev').textContent = `${imgs.length} photo${imgs.length === 1 ? '' : 's'} ready`; }
      catch (err) { imgs = []; $('#r-prev').textContent = ''; $('#r-err').innerHTML = `<div class="error-box">${esc(err.message)}</div>`; }
    };
    $('#r-send').onclick = async e => {
      $('#r-err').innerHTML = ''; const btn = e.target;
      if ($('#r-text').value.trim().length < 5) return ($('#r-err').innerHTML = '<div class="error-box">Describe the problem in a few words.</div>');
      if (!imgs.length) return ($('#r-err').innerHTML = '<div class="error-box">Add at least one photo.</div>');
      btn.disabled = true; btn.textContent = 'Sending…';
      try { await api('POST', '/api/complaint', { no, phone, reason: $('#r-reason').value, item: $('#r-item').value, text: $('#r-text').value.trim(), imgs }, T()); close(); toast('Report sent. The store will get back to you.'); showOrder(no, phone); }
      catch (err) { $('#r-err').innerHTML = `<div class="error-box">${esc(err.message)}</div>`; btn.disabled = false; btn.textContent = 'Send report'; }
    };
  }
  window.addEventListener('popstate', () => { if (S.info && S.pkg && !location.pathname.startsWith('/order/')) renderShop(); });
  boot();
})();
