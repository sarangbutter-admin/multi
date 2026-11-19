// Store back office + platform super-admin.
(() => {
  const { api, esc, money, $, $$, toast, store: ls, applyTheme } = SO;
  const A = { auth: ls.get('admin'), store: null, tab: ls.get('admin.tab') || 'orders', orderFilter: 'todo', timer: null };
  const app = $('#app'), dlg = $('#dlg');

  // ── api with the saved login ──
  async function call(method, path, body) {
    const a = A.auth || {};
    try { return await api(method, path, body, { tenant: a.role === 'super' ? undefined : a.slug, token: a.token }); }
    catch (e) { if (e.status === 401 && e.code === 'login_required') { logout('Your session ended. Please log in again.'); } throw e; }
  }
  function logout(msg) { A.auth = null; ls.set('admin', null); clearInterval(A.timer); call('POST', '/api/logout').catch(() => {}); showLogin(msg); }

  // ── small form kit ──
  const field = (label, name, value = '', o = {}) => o.type === 'checkbox'
    ? `<label class="check"><input type="checkbox" name="${name}" ${value ? 'checked' : ''}><span>${esc(label)}${o.hint ? `<small>${esc(o.hint)}</small>` : ''}</span></label>`
    : `<label class="f"><span>${esc(label)}${o.hint ? ` <span class="hint">${esc(o.hint)}</span>` : ''}</span>${
      o.type === 'textarea' ? `<textarea name="${name}" rows="${o.rows || 3}" ${o.attrs || ''}>${esc(value)}</textarea>`
      : o.type === 'select' ? `<select name="${name}" ${o.attrs || ''}>${o.options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value ?? '') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`
      : `<input name="${name}" type="${o.type || 'text'}" value="${esc(value ?? '')}" ${o.attrs || ''}>`}</label>`;
  function read(form) {
    const out = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.type === 'checkbox') out[el.name] = el.checked;
      else if (el.type === 'number') out[el.name] = el.value === '' ? null : Number(el.value);
      else out[el.name] = el.value.trim();
    }
    return out;
  }
  function busy(btn, on, text) { if (!btn) return; if (on) { btn.dataset.t = btn.textContent; btn.disabled = true; btn.textContent = text || 'Saving…'; } else { btn.disabled = false; btn.textContent = btn.dataset.t; } }
  function bindForm(form, fn, okMsg) {
    form.onsubmit = async e => {
      e.preventDefault(); const btn = $('button[type=submit], button:not([type])', form); $('.err', form)?.remove();
      busy(btn, true);
      try { await fn(read(form)); if (okMsg) toast(okMsg); }
      catch (err) { form.insertAdjacentHTML('beforeend', `<div class="err">${esc(err.message)}</div>`); }
      finally { busy(btn, false); }
    };
  }
  function dialog(title, inner, onSubmit, { submit = 'Save', danger } = {}) {
    dlg.innerHTML = `<form method="dialog"><div class="key-head"><h3>${esc(title)}</h3><button type="button" class="btn sec" data-close>Close</button></div>${inner}
      <div class="actions"><button class="btn" type="submit">${esc(submit)}</button>${danger ? `<button type="button" class="btn bad" data-danger>${esc(danger.label)}</button>` : ''}</div></form>`;
    const f = $('form', dlg);
    $('[data-close]', dlg).onclick = () => dlg.close();
    if (danger) $('[data-danger]', dlg).onclick = async () => { if (!confirm(danger.confirm)) return; try { await danger.fn(); dlg.close(); } catch (e) { toast(e.message, 'bad'); } };
    bindForm(f, async v => { await onSubmit(v, f); dlg.close(); });
    dlg.showModal();
  }

  // ── login / sign-up ──
  function showLogin(msg) {
    const last = ls.get('admin.lastSlug') || '';
    app.innerHTML = `<main class="auth"><h1>Log in to your store</h1><p class="muted">${esc(msg || 'Manage orders, products, stock and how your shop looks.')}</p>
      <form id="lf" class="panel">
        ${field('Store address', 'slug', last, { hint: 'leave empty for platform admin', attrs: 'autocapitalize="none" autocomplete="organization" placeholder="your-store"' })}
        ${field('Email', 'email', '', { type: 'email', attrs: 'autocomplete="email" required' })}
        ${field('Password', 'password', '', { type: 'password', attrs: 'autocomplete="current-password" required' })}
        <button class="btn full">Log in</button></form>
      <p class="switch muted">New here? <button class="linkish" id="to-signup">Open a store</button></p></main>`;
    $('#to-signup').onclick = showSignup;
    bindForm($('#lf'), async v => {
      const slug = v.slug.toLowerCase();
      const r = await api('POST', '/api/login', { email: v.email, password: v.password }, { tenant: slug || undefined });
      A.auth = { token: r.token, slug: slug || null, role: r.role }; ls.set('admin', A.auth); if (slug) ls.set('admin.lastSlug', slug);
      start();
    });
  }
  async function showSignup() {
    let site = null; try { site = (await api('GET', '/api/platform')).turnstile_site_key; } catch {}
    app.innerHTML = `<main class="auth"><h1>Open your store</h1><p class="muted">Set everything up right away. Customers can order once your store is approved.</p>
      <form id="sf" class="panel">
        ${field('Store name', 'store_name', '', { attrs: 'required maxlength="80"' })}
        ${field('Store address', 'slug', '', { hint: 'lowercase letters, numbers, dashes', attrs: 'required pattern="[a-z0-9][a-z0-9-]{1,30}[a-z0-9]" autocapitalize="none"' })}
        ${field('Your name', 'name', '', { attrs: 'autocomplete="name"' })}
        ${field('Email', 'email', '', { type: 'email', attrs: 'required autocomplete="email"' })}
        ${field('Password', 'password', '', { type: 'password', hint: '10+ characters', attrs: 'required minlength="10" autocomplete="new-password"' })}
        ${site ? '<div id="ts" style="margin-top:14px"></div>' : ''}
        <button class="btn full">Create store</button></form>
      <p class="switch muted">Already have a store? <button class="linkish" id="to-login">Log in</button></p></main>`;
    $('#to-login').onclick = () => showLogin();
    const f = $('#sf'), slugIn = f.elements.slug; let touched = false;
    slugIn.oninput = () => (touched = true);
    f.elements.store_name.oninput = e => { if (!touched) slugIn.value = e.target.value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32); };
    let tsToken = null;
    if (site) { window.__ts = () => window.turnstile.render('#ts', { sitekey: site, callback: t => (tsToken = t) }); const s = document.createElement('script'); s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=__ts&render=explicit'; document.head.append(s); }
    bindForm(f, async v => {
      const r = await api('POST', '/api/signup', { ...v, turnstile: tsToken });
      A.auth = { token: r.token, slug: r.store.slug, role: 'owner' }; ls.set('admin', A.auth); ls.set('admin.lastSlug', r.store.slug);
      A.tab = 'warehouses'; start();
    });
  }

  // ── shell ──
  const TABS = [['orders', 'Orders'], ['products', 'Products'], ['stock', 'Stock'], ['feedback', 'Feedback'], ['warehouses', 'Warehouses', 1], ['delivery', 'Delivery', 1], ['discounts', 'Discounts', 1], ['customers', 'Business', 1], ['look', 'Look', 1], ['payments', 'Payments', 1], ['settings', 'Settings', 1], ['staff', 'Staff', 1]];
  async function start() {
    if (!A.auth) return showLogin();
    app.innerHTML = '<div class="boot"><span class="spinner"></span></div>';
    try {
      if (A.auth.role === 'super') return superView();
      A.store = await call('GET', '/api/admin/store');
      shell();
    } catch (e) { if (A.auth) app.innerHTML = `<main class="auth"><div class="err">${esc(e.message)}</div><button class="btn full" id="re">Try again</button></main>`, $('#re').onclick = start; }
  }
  function shell() {
    const owner = A.auth.role === 'owner', tabs = TABS.filter(t => owner || !t[2]);
    if (!tabs.some(t => t[0] === A.tab)) A.tab = 'orders';
    app.innerHTML = `<header class="top"><div class="row"><h1>${esc(A.store.name)}</h1><span class="pill ${A.store.status}">${{ active: 'Open', pending: 'Waiting for approval', suspended: 'Suspended' }[A.store.status]}</span><button class="out" id="out">Log out</button></div>
      <nav class="tabs" aria-label="Sections">${tabs.map(([id, l]) => `<button data-tab="${id}">${l}${id === 'orders' ? '<span class="count" id="todo-count" hidden></span>' : ''}${id === 'feedback' ? '<span class="count" id="fb-count" hidden></span>' : ''}</button>`).join('')}</nav></header>
      <main id="main"></main>`;
    $('#out').onclick = () => logout();
    $$('.tabs button').forEach(b => (b.onclick = () => go(b.dataset.tab)));
    go(A.tab); badges();
  }
  async function badges() { try { const n = (await call('GET', '/api/admin/complaints')).rows.filter(r => r.status === 'open').length, b = $('#fb-count'); if (b) { b.hidden = !n; b.textContent = n; } } catch {} }
  function go(tab) {
    A.tab = tab; ls.set('admin.tab', tab); clearInterval(A.timer);
    $$('.tabs button').forEach(b => b.toggleAttribute('aria-current', b.dataset.tab === tab) || b.dataset.tab === tab && b.setAttribute('aria-current', 'page'));
    const m = $('#main');
    m.innerHTML = (A.store.status === 'pending' ? `<div class="banner">Your store is waiting for approval. Add warehouses, products and stock now, and customers can order as soon as it's approved.</div>` : '') + '<div id="view"><span class="spinner"></span></div>';
    VIEWS[tab]().catch(e => { $('#view').innerHTML = `<div class="err">${esc(e.message)}</div>`; });
  }
  const view = html => ($('#view').innerHTML = html);

  // ── orders ──
  const FILTERS = [['todo', 'To do', ['paid', 'preparing']], ['pending_payment', 'Unpaid', ['pending_payment']], ['shipped', 'On the way', ['shipped']], ['done', 'Done', ['delivered', 'cancelled', 'expired']], ['all', 'All', null]];
  const STATUS_LABEL = { pending_payment: 'Unpaid', paid: 'Paid', preparing: 'Preparing', shipped: 'On the way', delivered: 'Delivered', cancelled: 'Cancelled', expired: 'Expired' };
  const PAY_LABEL = { midtrans: 'Midtrans', doku: 'DOKU', manual: 'Bank transfer' };
  async function ordersView() {
    const [{ rows }, whs] = await Promise.all([call('GET', '/api/admin/orders'), call('GET', '/api/admin/warehouses')]);
    const wh = Object.fromEntries(whs.rows.map(w => [w.id, w.name]));
    const todo = rows.filter(o => ['paid', 'preparing'].includes(o.status)).length;
    const c = $('#todo-count'); if (c) { c.hidden = !todo; c.textContent = todo; }
    const f = FILTERS.find(x => x[0] === A.orderFilter), list = f[2] ? rows.filter(o => f[2].includes(o.status)) : rows;
    view(`<div class="head"><div><h2>Orders</h2><p class="muted">${todo ? `${todo} to prepare or send` : 'Nothing waiting'}. Updates every 20 seconds.</p></div></div>
      <div class="filters">${FILTERS.map(([k, l]) => `<button data-f="${k}" aria-pressed="${k === A.orderFilter}">${l}</button>`).join('')}</div>
      ${list.length ? `<div class="orders">${list.map(o => orderCard(o, wh)).join('')}</div>` : `<div class="empty">${A.orderFilter === 'todo' ? 'No orders to prepare right now.' : 'No orders here.'}</div>`}`);
    $$('[data-f]').forEach(b => (b.onclick = () => { A.orderFilter = b.dataset.f; ordersView(); }));
    $$('[data-act]').forEach(b => (b.onclick = () => orderAction(b)));
    clearInterval(A.timer); A.timer = setInterval(() => { if (!document.hidden && A.tab === 'orders' && !dlg.open) ordersView().catch(() => {}); }, 20000);
  }
  function orderCard(o, wh) {
    const pickup = o.shipping.provider === 'pickup', acts = [];
    if (o.status === 'pending_payment' && o.payment.provider === 'manual') acts.push(['pay', 'Confirm payment']);
    if (o.status === 'paid') acts.push(o.shipping.provider === 'biteship' ? ['book', 'Book courier'] : ['preparing', 'Start preparing']);
    if (o.status === 'preparing') acts.push(['shipped', pickup ? 'Ready for pick up' : 'Mark as sent']);
    if (o.status === 'shipped') acts.push(['delivered', pickup ? 'Picked up' : 'Mark delivered']);
    if (['pending_payment', 'paid', 'preparing'].includes(o.status)) acts.push(['cancelled', 'Cancel']);
    const t = new Date(o.created_at), phone = o.customer.phone.replace(/^0/, '62');
    return `<article class="order${o.payment.attention ? ' attn' : ''}">
      <div class="r1"><span class="no">${esc(o.no)}</span><span class="pill ${o.status}">${STATUS_LABEL[o.status]}</span></div>
      <div class="meta"><span>${t.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        <span>${esc(o.customer.name)}, <a href="https://wa.me/${esc(phone)}" target="_blank" rel="noopener">${esc(o.customer.phone)}</a></span></div>
      <ul>${o.items.map(i => `<li><span>${i.qty} × ${esc(i.label)}</span><span>${money(i.price * i.qty)}</span></li>`).join('')}
        ${o.tier_discount ? `<li><span>Discount${o.b2b_id ? ' (business)' : ''}</span><span>−${money(o.tier_discount)}</span></li>` : ''}${o.coupon_discount ? `<li><span>Coupon ${esc(o.coupon_code)}</span><span>−${money(o.coupon_discount)}</span></li>` : ''}
        <li><span>${esc(o.shipping.label)}</span><span>${o.shipping_fee ? money(o.shipping_fee) : 'Free'}</span></li>
        <li class="total"><span>Total, ${PAY_LABEL[o.payment.provider]}</span><span>${money(o.total)}</span></li></ul>
      <div class="meta"><span>From ${esc(wh[o.warehouse_id] || 'a removed warehouse')}</span>
        ${pickup ? '' : `<span>${esc(o.destination.address || '')}${o.destination.postal_code ? ` ${esc(o.destination.postal_code)}` : ''}${o.destination.note ? ` (${esc(o.destination.note)})` : ''}</span>`}
        ${o.shipping.booking?.waybill ? `<span>Tracking number ${esc(o.shipping.booking.waybill)}</span>` : ''}
        ${o.payment.attention ? '<span style="color:var(--bad);font-weight:600">Paid after the order expired and the stock was gone. Refund or restock this customer.</span>' : ''}</div>
      ${acts.length ? `<div class="actions">${acts.map(([k, l]) => `<button class="btn ${k === 'cancelled' ? 'bad' : ''}" data-act="${k}" data-no="${esc(o.no)}">${l}</button>`).join('')}</div>` : ''}</article>`;
  }
  async function orderAction(b) {
    const { act, no } = b.dataset;
    if (act === 'cancelled' && !confirm(`Cancel order ${no}? If it's already paid, refund the customer yourself.`)) return;
    busy(b, true, 'Working…');
    try {
      if (act === 'pay') await call('POST', `/api/admin/orders/${no}/confirm-payment`);
      else if (act === 'book') { const r = await call('POST', `/api/admin/orders/${no}/book`); toast(r.booking.waybill ? `Courier booked, tracking ${r.booking.waybill}` : 'Courier booked'); }
      else await call('PATCH', `/api/admin/orders/${no}`, { status: act });
      await ordersView();
    } catch (e) { toast(e.message, 'bad'); busy(b, false); }
  }

  // ── products ──
  async function productsView() {
    const [p, v] = await Promise.all([call('GET', '/api/admin/products'), call('GET', '/api/admin/variants')]);
    const prods = p.rows.sort((a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name));
    view(`<div class="head"><div><h2>Products</h2><p class="muted">Each product needs at least one option with a price, for example a size or a box of 6.</p></div><button class="btn" id="add-p">Add product</button></div>
      ${prods.length ? prods.map(pr => { const vs = v.rows.filter(x => x.product_id === pr.id); return `<div class="panel ${pr.active ? '' : 'off'}">
        <div class="prod">${pr.image ? `<img class="thumb" src="${esc(pr.image)}" alt="">` : `<span class="thumb">${esc(pr.name.slice(0, 1))}</span>`}
        <div><b>${esc(pr.name)}</b><div class="muted small">${esc(pr.category || 'No category')}${pr.active ? '' : ', hidden from the menu'}</div></div>
        <button class="btn sec" data-ep="${pr.id}">Edit</button></div>
        ${vs.map(x => `<div class="vrow ${x.active ? '' : 'off'}"><span>${esc(x.name)}${x.weight_g ? ` <span class="muted">${x.weight_g} g</span>` : ''}</span><span>${money(x.price)} <button class="linkish" data-ev="${x.id}">Edit</button></span></div>`).join('')}
        <div class="actions"><button class="btn sec" data-av="${pr.id}">Add option</button></div></div>`; }).join('')
        : '<div class="empty">No products yet. Add your first one.</div>'}`);
    $('#add-p').onclick = () => productDialog();
    $$('[data-ep]').forEach(b => (b.onclick = () => productDialog(prods.find(x => x.id === b.dataset.ep))));
    $$('[data-av]').forEach(b => (b.onclick = () => variantDialog({ product_id: b.dataset.av, name: prods.find(x => x.id === b.dataset.av).name })));
    $$('[data-ev]').forEach(b => (b.onclick = () => variantDialog(v.rows.find(x => x.id === b.dataset.ev))));
  }
  function productDialog(p = { active: true }) {
    dialog(p.id ? 'Edit product' : 'Add product', `
      ${field('Name', 'name', p.name, { attrs: 'required' })}
      ${field('Category', 'category', p.category, { hint: 'groups the menu, e.g. Cookies' })}
      ${field('Description', 'description', p.description, { type: 'textarea' })}
      ${field('Photo link', 'image', p.image, { type: 'url', hint: 'https:// link to a square photo', attrs: 'placeholder="https://"' })}
      <div class="cols">${field('Menu order', 'sort', p.sort ?? 0, { type: 'number', hint: 'lower shows first' })}</div>
      ${field('Show on the menu', 'active', p.active, { type: 'checkbox' })}
      ${p.id ? '' : `<div class="cols">${field('First option name', 'v_name', '', { hint: 'e.g. Box of 6', attrs: 'required' })}${field('Price', 'v_price', '', { type: 'number', attrs: 'required min="0" step="1"' })}${field('Weight (g)', 'v_weight', '', { type: 'number', hint: 'for courier rates', attrs: 'min="0"' })}</div>`}`,
      async val => {
        const { v_name, v_price, v_weight, ...pv } = val;
        if (p.id) await call('PATCH', `/api/admin/products/${p.id}`, pv);
        else { const r = await call('POST', '/api/admin/products', pv); await call('POST', '/api/admin/variants', { product_id: r.row.id, name: v_name, price: v_price, weight_g: v_weight || 0 }); }
        toast(p.id ? 'Product saved' : 'Product added. Now set its stock.'); productsView();
      }, { submit: p.id ? 'Save product' : 'Add product', danger: p.id && { label: 'Delete', confirm: `Delete ${p.name} and its options? Past orders keep their copy.`, fn: async () => { await call('DELETE', `/api/admin/products/${p.id}`); productsView(); } } });
  }
  function variantDialog(v) {
    dialog(v.id ? 'Edit option' : `Add option to ${v.name}`, `
      ${field('Option name', 'name', v.id ? v.name : '', { attrs: 'required', hint: 'e.g. Box of 12' })}
      <div class="cols">${field('Price', 'price', v.price, { type: 'number', attrs: 'required min="0" step="1"' })}${field('Weight (g)', 'weight_g', v.weight_g, { type: 'number', attrs: 'min="0"' })}${field('SKU', 'sku', v.sku)}</div>
      ${field('Available to order', 'active', v.id ? v.active : true, { type: 'checkbox' })}`,
      async val => { if (v.id) await call('PATCH', `/api/admin/variants/${v.id}`, val); else await call('POST', '/api/admin/variants', { ...val, product_id: v.product_id }); toast('Option saved'); productsView(); },
      { danger: v.id && { label: 'Delete', confirm: 'Delete this option?', fn: async () => { await call('DELETE', `/api/admin/variants/${v.id}`); productsView(); } } });
  }

  // ── stock grid: options × warehouses ──
  async function stockView() {
    const [p, v, w, s] = await Promise.all(['products', 'variants', 'warehouses', 'stock'].map(x => call('GET', '/api/admin/' + x)));
    const whs = w.rows.filter(x => x.active), st = Object.fromEntries(s.rows.map(r => [r.warehouse_id + '|' + r.variant_id, r]));
    const pn = Object.fromEntries(p.rows.map(x => [x.id, x.name]));
    if (!whs.length) return view(`<div class="head"><h2>Stock</h2></div><div class="empty">Add a warehouse first, then set how many of each item it holds.</div>`);
    if (!v.rows.length) return view(`<div class="head"><h2>Stock</h2></div><div class="empty">Add products first.</div>`);
    view(`<div class="head"><div><h2>Stock</h2><p class="muted">Units on the shelf in each warehouse. Changes save as you type. "Held" units belong to unpaid orders.</p></div></div>
      <div class="table-wrap"><table><thead><tr><th>Item</th>${whs.map(x => `<th class="num">${esc(x.name)}</th>`).join('')}<th class="num">Total</th></tr></thead><tbody>
      ${v.rows.sort((a, b) => (pn[a.product_id] || '').localeCompare(pn[b.product_id] || '')).map(x => { const tot = whs.reduce((n, w) => n + (st[w.id + '|' + x.id]?.qty || 0), 0); return `<tr><td>${esc(pn[x.product_id] || '')}<div class="muted small">${esc(x.name)}</div></td>
        ${whs.map(w => { const r = st[w.id + '|' + x.id]; return `<td class="num"><input class="stock-in" type="number" min="0" step="1" inputmode="numeric" value="${r?.qty ?? 0}" data-w="${w.id}" data-v="${x.id}" aria-label="${esc(pn[x.product_id])} ${esc(x.name)} at ${esc(w.name)}">${r?.reserved ? `<span class="held">${r.reserved} held</span>` : ''}</td>`; }).join('')}
        <td class="num"><b>${tot}</b></td></tr>`; }).join('')}</tbody></table></div>`);
    $$('.stock-in').forEach(i => {
      let t; i.oninput = () => { clearTimeout(t); i.classList.remove('saved'); t = setTimeout(save, 600); };
      const save = async () => { if (i.value === '') return; try { await call('PUT', '/api/admin/stock', { warehouse_id: i.dataset.w, variant_id: i.dataset.v, qty: Number(i.value) }); i.classList.add('saved'); } catch (e) { toast(e.message, 'bad'); } };
    });
  }

  // ── warehouses ──
  async function warehousesView() {
    const { rows } = await call('GET', '/api/admin/warehouses');
    view(`<div class="head"><div><h2>Warehouses</h2><p class="muted">Each order ships from the nearest warehouse that has everything in it. A shop or kitchen counts too.</p></div><button class="btn" id="add-w">Add warehouse</button></div>
      ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Address</th><th>Location</th><th></th></tr></thead><tbody>${rows.map(w => `<tr class="${w.active ? '' : 'off'}">
        <td><b>${esc(w.name)}</b>${w.active ? '' : '<div class="muted small">Not shipping</div>'}</td><td>${esc(w.address || '')} ${esc(w.postal_code || '')}</td>
        <td>${w.lat != null ? '<span class="pill on">Set</span>' : '<span class="pill pending">Missing</span>'}</td><td><button class="btn sec" data-ew="${w.id}">Edit</button></td></tr>`).join('')}</tbody></table></div>`
        : '<div class="empty">No warehouses yet. Add the place your orders ship from.</div>'}`);
    $('#add-w').onclick = () => warehouseDialog();
    $$('[data-ew]').forEach(b => (b.onclick = () => warehouseDialog(rows.find(x => x.id === b.dataset.ew))));
  }
  function warehouseDialog(w = { active: true, contact: {} }) {
    dialog(w.id ? 'Edit warehouse' : 'Add warehouse', `
      ${field('Name', 'name', w.name, { attrs: 'required', hint: 'customers see this for pick up' })}
      ${field('Address', 'address', w.address, { type: 'textarea', rows: 2 })}
      <div class="cols">${field('Postal code', 'postal_code', w.postal_code, { attrs: 'inputmode="numeric" maxlength="5"' })}${field('Latitude', 'lat', w.lat, { type: 'number', attrs: 'step="any"' })}${field('Longitude', 'lng', w.lng, { type: 'number', attrs: 'step="any"' })}</div>
      <button type="button" class="btn sec" id="here" style="margin-top:10px">Use this device's location</button>
      <p class="muted small">Location decides which warehouse is closest and your store courier's distance zones.</p>
      <div class="cols">${field('Pick-up contact', 'c_name', w.contact?.name)}${field('Contact phone', 'c_phone', w.contact?.phone, { attrs: 'inputmode="tel"' })}</div>
      <div class="cols">${field('Priority', 'priority', w.priority ?? 0, { type: 'number', hint: 'higher wins a tie' })}${field('Biteship area ID', 'area_id', w.area_id, { hint: 'optional' })}</div>
      ${field('Shipping orders', 'active', w.active, { type: 'checkbox' })}`,
      async ({ c_name, c_phone, ...val }) => {
        const body = { ...val, contact: { name: c_name, phone: c_phone } };
        if (w.id) await call('PATCH', `/api/admin/warehouses/${w.id}`, body); else await call('POST', '/api/admin/warehouses', body);
        toast('Warehouse saved'); warehousesView();
      }, { danger: w.id && { label: 'Delete', confirm: `Delete ${w.name}? Its stock records are removed too.`, fn: async () => { await call('DELETE', `/api/admin/warehouses/${w.id}`); warehousesView(); } } });
    $('#here', dlg).onclick = () => navigator.geolocation?.getCurrentPosition(p => { const f = $('form', dlg); f.elements.lat.value = p.coords.latitude.toFixed(6); f.elements.lng.value = p.coords.longitude.toFixed(6); }, () => toast('Location is off on this device', 'bad'));
  }

  // ── delivery: pickup, couriers, store courier zones ──
  async function deliveryView() {
    const [z, w, keys] = await Promise.all([call('GET', '/api/admin/zones'), call('GET', '/api/admin/warehouses'), call('GET', '/api/admin/secrets')]);
    const s = A.store.settings, wn = Object.fromEntries(w.rows.map(x => [x.id, x.name]));
    view(`<div class="head"><div><h2>Delivery</h2><p class="muted">Choose how customers get their order. They'll see every option that reaches them, with its price.</p></div></div>
      <form class="panel" id="dset"><h3>Ways to get an order</h3>
        ${field('Pick up', 'pickup', s.pickup, { type: 'checkbox', hint: 'customers collect from the nearest warehouse, free' })}
        ${field('Courier companies (Biteship)', 'biteship', s.biteship, { type: 'checkbox', hint: keys.biteship.configured ? 'live rates from JNE, SiCepat, GoSend and others' : 'add your Biteship key under Payments first' })}
        <div class="actions"><button class="btn">Save</button></div></form>
      <div class="panel"><div class="key-head"><div><h3>Your own couriers</h3><p class="muted small" style="margin:0">Distance zones from the warehouse. The smallest zone that reaches the customer sets the fee.</p></div><button class="btn sec" id="add-z">Add zone</button></div>
        ${z.rows.length ? `<div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>Zone</th><th>From</th><th class="num">Up to</th><th class="num">Fee</th><th></th></tr></thead><tbody>
          ${z.rows.sort((a, b) => a.max_km - b.max_km).map(x => `<tr><td>${esc(x.name)}${x.eta ? `<div class="muted small">${esc(x.eta)}</div>` : ''}</td><td>${esc(x.warehouse_id ? wn[x.warehouse_id] || '' : 'Any warehouse')}</td><td class="num">${x.max_km} km</td><td class="num">${money(x.fee)}</td><td><button class="linkish" data-dz="${x.id}">Remove</button></td></tr>`).join('')}</tbody></table></div>`
          : '<p class="muted">No zones yet. Without zones your own couriers aren\'t offered.</p>'}</div>`);
    bindForm($('#dset'), async v => { A.store.settings = (await call('PUT', '/api/admin/settings', v)).settings; }, 'Delivery options saved');
    $('#add-z').onclick = () => dialog('Add delivery zone', `${field('Zone name', 'name', '', { attrs: 'required', hint: 'e.g. Nearby' })}
      ${field('Ships from', 'warehouse_id', '', { type: 'select', options: [['', 'Any warehouse'], ...w.rows.map(x => [x.id, x.name])] })}
      <div class="cols">${field('Up to (km)', 'max_km', '', { type: 'number', attrs: 'required min="0.1" step="0.1"' })}${field('Fee', 'fee', '', { type: 'number', attrs: 'required min="0" step="1"' })}</div>
      ${field('Delivery time', 'eta', '', { hint: 'e.g. 30–60 minutes' })}`, async v => { await call('POST', '/api/admin/zones', v); toast('Zone added'); deliveryView(); });
    $$('[data-dz]').forEach(b => (b.onclick = async () => { await call('DELETE', `/api/admin/zones/${b.dataset.dz}`); deliveryView(); }));
  }

  // ── look: theme editor with a live phone preview ──
  async function lookView() {
    const th = { ...A.store.theme }, fonts = A.store.fonts;
    const COLORS = [['primary', 'Main colour'], ['accent', 'Highlight'], ['background', 'Background'], ['surface', 'Cards'], ['text', 'Text']];
    view(`<div class="head"><div><h2>Look</h2><p class="muted">How your shop looks to customers. The preview updates as you change things.</p></div></div>
      <div class="look"><form class="panel" id="lf">
        <h3>Colours</h3><div class="swatches">${COLORS.map(([k, l]) => `<label class="sw"><input type="color" name="${k}" value="${esc(th[k])}"><span>${l}<code>${esc(th[k])}</code></span></label>`).join('')}</div>
        <div class="cols">${field('Font', 'font', th.font, { type: 'select', options: fonts.map(f => [f, f]) })}
          ${field('Menu layout', 'layout', th.layout, { type: 'select', options: [['grid', 'Photo grid'], ['list', 'List']] })}
          ${field('Start from', 'mode', th.mode, { type: 'select', options: [['light', 'Light colours'], ['dark', 'Dark colours']], attrs: 'aria-describedby="mode-hint"' })}</div><p class="muted small" id="mode-hint" style="margin:6px 0 0">Picking light or dark fills in background, cards and text colours. You can still change each one.</p>
        ${field('Corner roundness', 'radius', th.radius, { type: 'range', attrs: 'min="0" max="32" step="1"' })}
        ${field('Logo link', 'logo', th.logo, { type: 'url', hint: 'square image, https://', attrs: 'placeholder="https://"' })}
        ${field('Banner link', 'banner', th.banner, { type: 'url', hint: 'wide image, optional', attrs: 'placeholder="https://"' })}
        <div class="actions"><button class="btn">Save look</button><button type="button" class="btn sec" id="reset">Undo changes</button></div></form>
        <div class="preview-col"><div class="preview-frame"><div class="preview" id="pv"></div></div></div></div>`);
    const f = $('#lf'), pv = $('#pv');
    const cur = () => { const v = read(f); v.radius = Number(v.radius); return { ...th, ...v }; };
    const draw = () => {
      const t = cur(); applyTheme(t, pv);
      $$('.sw', f).forEach(sw => ($('code', sw).textContent = $('input', sw).value.toUpperCase()));
      const card = (n, p) => `<div class="p-card"><div class="p-ph">${n[0]}</div><div class="p-txt"><b>${n}</b><span>${money(p)}</span></div></div>`;
      pv.innerHTML = `<div class="p-top"><span class="p-logo">${t.logo ? `<img src="${esc(t.logo)}" alt="">` : esc(A.store.name[0])}</span><b>${esc(A.store.name)}</b></div>
        ${t.banner ? `<img class="p-banner" src="${esc(t.banner)}" alt="">` : ''}
        <div class="p-body"><div class="p-cat">Popular</div><div class="p-${t.layout}">${card('Butter cookies', 55000)}${card('Brownie box', 80000)}${card('Cheese tart', 45000)}${card('Iced latte', 28000)}</div></div>
        <div class="p-bar"><span>2 items</span><span>${money(135000)}</span></div>`;
    };
    const PRESETS = { light: { background: '#F3F7F2', surface: '#FFFFFF', text: '#13241B' }, dark: { background: '#10201A', surface: '#18302A', text: '#EAF4E4' } };
    f.elements.mode.onchange = e => { for (const [k, v] of Object.entries(PRESETS[e.target.value])) f.elements[k].value = v; draw(); };
    f.oninput = draw; draw();
    $('#reset').onclick = () => lookView();
    bindForm(f, async v => { v.radius = Number(v.radius); A.store.theme = (await call('PUT', '/api/admin/theme', v)).theme; }, 'Look saved. Customers see it on their next visit.');
  }

  // ── payments & connected services (per-store keys) ──
  const SERVICES = [
    ['midtrans', 'Midtrans', 'Online payment: QRIS, e-wallets, virtual accounts, cards.', [['serverKey', 'Server key', 'secret'], ['clientKey', 'Client key'], ['production', 'Live mode (turn off to test with sandbox keys)', 'bool']], 'Paste this into Midtrans: Settings, Payment, Notification URL.'],
    ['doku', 'DOKU', 'Online payment through DOKU Checkout.', [['clientId', 'Client ID'], ['secretKey', 'Secret key', 'secret'], ['production', 'Live mode (turn off to test with sandbox keys)', 'bool']], 'Paste this into DOKU Back Office as your notification URL.'],
    ['biteship', 'Biteship', 'Courier rates, booking and tracking.', [['apiKey', 'API key', 'secret'], ['couriers', 'Couriers to offer', 'text', 'e.g. jne,sicepat,jnt,gojek,grab']], 'Paste this into Biteship: Settings, Webhook, for order status updates.'],
    ['turnstile', 'Cloudflare Turnstile', 'Stops bots from placing fake orders. Free.', [['siteKey', 'Site key'], ['secretKey', 'Secret key', 'secret']], null]
  ];
  async function paymentsView() {
    const keys = await call('GET', '/api/admin/secrets'), s = A.store.settings, pays = s.payments || ['manual'], m = s.manual || {};
    view(`<div class="head"><div><h2>Payments</h2><p class="muted">Your own accounts. Money goes straight to you; keys are stored encrypted and never shown again in full.</p></div></div>
      <form class="panel" id="pm"><h3>What customers can pay with</h3>
        ${field('Online with Midtrans', 'p_midtrans', pays.includes('midtrans'), { type: 'checkbox', hint: keys.midtrans.configured ? '' : 'connect Midtrans below first' })}
        ${field('Online with DOKU', 'p_doku', pays.includes('doku'), { type: 'checkbox', hint: keys.doku.configured ? '' : 'connect DOKU below first' })}
        ${field('Bank transfer', 'p_manual', pays.includes('manual'), { type: 'checkbox', hint: 'you confirm each payment in Orders' })}
        <div class="cols">${field('Bank', 'bank', m.bank)}${field('Account number', 'account_no', m.account_no)}${field('Account name', 'account_name', m.account_name)}</div>
        ${field('Transfer instructions', 'note', m.note, { hint: 'optional' })}
        <div class="cols">${field('Time to pay (minutes)', 'pay_minutes', s.pay_minutes || 60, { type: 'number', attrs: 'min="15" max="1440"', hint: 'unpaid orders release their stock after this' })}</div>
        <div class="actions"><button class="btn">Save payment options</button></div></form>
      <div class="grid2">${SERVICES.map(([id, name, desc, fields, hookHelp]) => { const k = keys[id]; return `<form class="panel" data-svc="${id}">
        <div class="key-head"><h3>${name}</h3><span class="pill ${k.configured ? 'on' : ''}">${k.configured ? 'Connected' : 'Not connected'}</span></div><p class="muted small" style="margin:2px 0 0">${desc}</p>
        ${fields.map(([n, l, kind, ph]) => kind === 'bool' ? field(l, n, k.fields[n], { type: 'checkbox' }) : field(l, n, kind === 'secret' ? '' : k.fields[n], { type: kind === 'secret' ? 'password' : 'text', attrs: `autocomplete="off" placeholder="${esc(kind === 'secret' && k.fields[n] ? 'Saved ' + k.fields[n] + ', type to replace' : ph || '')}"` })).join('')}
        ${hookHelp && (k.notify_url || k.webhook_url) ? `<p class="muted small" style="margin:12px 0 0">${hookHelp}</p><div class="copy"><input readonly value="${esc(k.notify_url || k.webhook_url)}"><button type="button" class="btn sec" data-copy>Copy</button></div>` : ''}
        <div class="actions"><button class="btn">${k.configured ? 'Update' : 'Connect'}</button>${k.configured ? '<button type="button" class="btn bad" data-disc>Disconnect</button>' : ''}</div></form>`; }).join('')}</div>`);
    bindForm($('#pm'), async v => {
      const payments = ['midtrans', 'doku', 'manual'].filter(p => v['p_' + p]);
      A.store.settings = (await call('PUT', '/api/admin/settings', { payments, pay_minutes: v.pay_minutes, manual: { bank: v.bank, account_no: v.account_no, account_name: v.account_name, note: v.note } })).settings;
    }, 'Payment options saved');
    $$('[data-svc]').forEach(f => {
      const id = f.dataset.svc;
      bindForm(f, async v => { for (const k of Object.keys(v)) if (v[k] === '') delete v[k]; await call('PUT', `/api/admin/secrets/${id}`, v); toast('Saved'); paymentsView(); });
      $('[data-copy]', f) && ($('[data-copy]', f).onclick = () => { navigator.clipboard?.writeText($('.copy input', f).value); toast('Copied'); });
      $('[data-disc]', f) && ($('[data-disc]', f).onclick = async () => { if (confirm('Disconnect? Customers can no longer use it.')) { await call('DELETE', `/api/admin/secrets/${id}`); paymentsView(); } });
    });
  }

  // ── settings ──
  async function settingsView() {
    const s = A.store.settings, plat = await api('GET', '/api/platform').catch(() => ({}));
    const link = plat.domain ? `https://${A.store.slug}.${plat.domain}` : `${location.origin}/?store=${A.store.slug}`;
    view(`<div class="head"><div><h2>Settings</h2></div></div>
      <form class="panel" id="st">
        ${field('Store name', 'name', A.store.name, { attrs: 'required' })}
        ${field('About your store', 'about', s.about, { type: 'textarea', hint: 'shown at the top of the menu' })}
        ${field('WhatsApp for customers', 'whatsapp', s.whatsapp, { attrs: 'inputmode="tel"', hint: 'with country code, e.g. 62812…' })}
        ${field('List my store in the app', 'listed', s.listed !== false, { type: 'checkbox', hint: 'customers can find you in the store list' })}
        <div class="actions"><button class="btn">Save settings</button></div></form>
      <div class="panel"><h3>Your shop link</h3><p class="muted small" style="margin:0">Share it anywhere. It opens your shop directly.</p><div class="copy"><input readonly value="${esc(link)}"><button type="button" class="btn sec" id="cp">Copy</button></div></div>`);
    $('#cp').onclick = () => { navigator.clipboard?.writeText(link); toast('Link copied'); };
    bindForm($('#st'), async v => { A.store.settings = (await call('PUT', '/api/admin/settings', v)).settings; A.store.name = v.name; $('.top h1').textContent = v.name; }, 'Settings saved');
  }

  // ── staff ──
  async function staffView() {
    const { rows } = await call('GET', '/api/admin/staff');
    view(`<div class="head"><div><h2>Staff</h2><p class="muted">Staff can handle orders, products and stock. Only owners see keys, look and settings.</p></div><button class="btn" id="add-s">Add staff</button></div>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th></th></tr></thead><tbody>${rows.map(u => `<tr><td>${esc(u.name || '')}</td><td>${esc(u.email)}</td><td>${u.role === 'owner' ? 'Owner' : 'Staff'}</td>
        <td>${u.role === 'staff' ? `<button class="linkish" data-rs="${u.id}">Remove</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`);
    $('#add-s').onclick = () => dialog('Add staff', `${field('Name', 'name')}${field('Email', 'email', '', { type: 'email', attrs: 'required' })}${field('Password', 'password', '', { type: 'password', hint: '10+ characters, share it privately', attrs: 'required minlength="10" autocomplete="new-password"' })}`,
      async v => { await call('POST', '/api/admin/staff', v); toast('Staff added'); staffView(); }, { submit: 'Add staff' });
    $$('[data-rs]').forEach(b => (b.onclick = async () => { if (confirm('Remove this staff account?')) { await call('DELETE', `/api/admin/staff/${b.dataset.rs}`); staffView(); } }));
  }


  // ── discounts: coupons + volume tiers ──
  async function discountsView() {
    const { rows } = await call('GET', '/api/admin/coupons'), t = A.store.settings.tiers || {};
    const tier = (k, title, hint, d) => { const v = { qty: d.qty, amt: 0, pct: 0, ...(t[k] || {}) }; return `<form class="panel" data-tier="${k}"><h3>${title}</h3><p class="muted small" style="margin:2px 0 0">${hint}</p>
      <div class="cols">${field('Discount %', 'pct', v.pct, { type: 'number', attrs: 'min="0" max="50" step="1"', hint: '0 turns it off' })}${field('Minimum items', 'qty', v.qty, { type: 'number', attrs: 'min="1" step="1"' })}${field('Minimum spend', 'amt', v.amt, { type: 'number', attrs: 'min="0" step="1"' })}</div>
      <div class="actions"><button class="btn">Save</button></div></form>`; };
    const state = c => c.active === false ? ['Off', ''] : c.expires_at && new Date(c.expires_at) < new Date() ? ['Expired', 'expired'] : c.max_uses > 0 && c.used >= c.max_uses ? ['Used up', 'expired'] : ['Active', 'on'];
    view(`<div class="head"><div><h2>Discounts</h2><p class="muted">Coupon codes customers type at checkout, and automatic discounts for bigger orders.</p></div><button class="btn" id="add-c">Add coupon</button></div>
      ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Code</th><th>Discount</th><th>Rules</th><th class="num">Used</th><th>Status</th><th></th></tr></thead><tbody>${rows.map(c => { const [lbl, cls] = state(c); return `<tr>
        <td><b>${esc(c.code)}</b></td><td>${c.type === 'pct' ? c.value + '% off' : money(c.value) + ' off'}</td>
        <td class="muted small">${c.min_purchase ? `Spend ${money(c.min_purchase)}+` : 'No minimum'}${c.expires_at ? `, until ${new Date(c.expires_at).toLocaleDateString()}` : ''}</td>
        <td class="num">${c.used}${c.max_uses ? ` / ${c.max_uses}` : ''}</td><td><span class="pill ${cls}">${lbl}</span></td><td><button class="btn sec" data-ec="${c.id}">Edit</button></td></tr>`; }).join('')}</tbody></table></div>`
        : '<div class="empty">No coupons yet. Add one to run a promotion.</div>'}
      <div class="head" style="margin-top:22px"><div><h3 style="margin:0;font-size:18px">Automatic discounts</h3><p class="muted">Applied before any coupon. Leave at 0% to keep them off.</p></div></div>
      <div class="grid2">${tier('regular', 'Everyone', 'For example 5% off when someone orders 10 or more items.', { qty: 10 })}${tier('b2b', 'Business accounts', 'Better prices for customers with a business login.', { qty: 1 })}</div>`);
    $('#add-c').onclick = () => couponDialog();
    $$('[data-ec]').forEach(b => (b.onclick = () => couponDialog(rows.find(x => x.id === b.dataset.ec))));
    $$('[data-tier]').forEach(f => bindForm(f, async v => {
      A.store.settings = (await call('PUT', '/api/admin/settings', { tiers: { [f.dataset.tier]: { pct: v.pct ?? 0, qty: v.qty ?? 1, amt: v.amt ?? 0 } } })).settings;
    }, 'Saved'));
  }
  function couponDialog(c = { type: 'pct', active: true }) {
    dialog(c.id ? 'Edit coupon' : 'Add coupon', `
      ${field('Code', 'code', c.code, { attrs: 'required maxlength="16" autocapitalize="characters" style="text-transform:uppercase"', hint: 'letters and numbers, what customers type' })}
      <div class="cols">${field('Type', 'type', c.type, { type: 'select', options: [['pct', 'Percent off'], ['amt', 'Amount off']] })}${field('How much', 'value', c.value, { type: 'number', attrs: 'required min="1" step="1"' })}</div>
      <div class="cols">${field('Minimum spend', 'min_purchase', c.min_purchase || 0, { type: 'number', attrs: 'min="0" step="1"' })}${field('Uses allowed', 'max_uses', c.max_uses || 0, { type: 'number', attrs: 'min="0" step="1"', hint: '0 means unlimited' })}</div>
      ${field('Last day', 'expires_at', c.expires_at ? c.expires_at.slice(0, 10) : '', { type: 'date', hint: 'optional' })}
      ${field('Accepting this code', 'active', c.active !== false, { type: 'checkbox' })}`,
      async v => {
        v.expires_at = v.expires_at ? new Date(v.expires_at + 'T23:59:59').toISOString() : null;
        if (c.id) await call('PATCH', `/api/admin/coupons/${c.id}`, v); else await call('POST', '/api/admin/coupons', v);
        toast('Coupon saved'); discountsView();
      }, { danger: c.id && { label: 'Delete', confirm: `Delete coupon ${c.code}? Past orders keep their discount.`, fn: async () => { await call('DELETE', `/api/admin/coupons/${c.id}`); discountsView(); } } });
  }

  // ── business accounts ──
  async function customersView() {
    const { rows } = await call('GET', '/api/admin/b2b');
    view(`<div class="head"><div><h2>Business accounts</h2><p class="muted">Shops and cafes that order from you. They log in on the app (My orders, Business account) to get your business discount.</p></div><button class="btn" id="add-b">Add business</button></div>
      ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Business</th><th>Username</th><th>Phone</th><th>Status</th><th></th></tr></thead><tbody>${rows.map(a => `<tr class="${a.active ? '' : 'off'}">
        <td><b>${esc(a.name)}</b></td><td>${esc(a.login)}</td><td>${esc(a.phone || '')}</td><td><span class="pill ${a.active ? 'on' : ''}">${a.active ? 'Active' : 'Off'}</span></td><td><button class="btn sec" data-eb="${a.id}">Edit</button></td></tr>`).join('')}</tbody></table></div>`
        : '<div class="empty">No business accounts yet. Set the business discount under Discounts, then add your first one.</div>'}`);
    $('#add-b').onclick = () => dialog('Add business', `${field('Business name', 'name', '', { attrs: 'required' })}${field('Phone', 'phone', '', { attrs: 'inputmode="tel"' })}
      ${field('Username', 'login', '', { attrs: 'required pattern="[a-z0-9_.]{3,20}" autocapitalize="none"', hint: '3–20 letters, numbers, . or _' })}${field('Password', 'password', '', { type: 'password', attrs: 'required minlength="10" autocomplete="new-password"', hint: '10+ characters, share it privately' })}`,
      async v => { await call('POST', '/api/admin/b2b', v); toast('Business added'); customersView(); }, { submit: 'Add business' });
    $$('[data-eb]').forEach(b => (b.onclick = () => { const a = rows.find(x => x.id === b.dataset.eb);
      dialog('Edit business', `${field('Business name', 'name', a.name, { attrs: 'required' })}${field('Phone', 'phone', a.phone, { attrs: 'inputmode="tel"' })}
        <p class="muted small">Username: <b>${esc(a.login)}</b></p>${field('New password', 'password', '', { type: 'password', attrs: 'minlength="10" autocomplete="new-password"', hint: 'leave empty to keep the current one' })}
        ${field('Can log in', 'active', a.active, { type: 'checkbox' })}`,
        async v => { if (!v.password) delete v.password; await call('PATCH', `/api/admin/b2b/${a.id}`, v); toast('Saved'); customersView(); },
        { danger: { label: 'Delete', confirm: `Delete ${a.name}? They can no longer log in.`, fn: async () => { await call('DELETE', `/api/admin/b2b/${a.id}`); customersView(); } } }); }));
  }

  // ── feedback: complaints and reviews ──
  async function feedbackView() {
    const [cm, rv] = await Promise.all([call('GET', '/api/admin/complaints'), call('GET', '/api/admin/reviews')]);
    const open = cm.rows.filter(r => r.status === 'open').length, b = $('#fb-count'); if (b) { b.hidden = !open; b.textContent = open; }
    const stars = n => '★'.repeat(n) + '☆'.repeat(5 - n);
    view(`<div class="head"><div><h2>Feedback</h2><p class="muted">${open ? `${open} problem report${open === 1 ? '' : 's'} waiting for you` : 'No open problem reports'}.</p></div></div>
      ${cm.rows.length ? `<div class="orders">${cm.rows.map(r => `<article class="order ${r.status === 'open' ? 'attn' : ''}"><div class="r1"><span class="no">${esc(r.order_no)}</span><span class="pill ${r.status === 'open' ? 'pending' : r.status === 'resolved' ? 'on' : 'cancelled'}">${{ open: 'Open', resolved: 'Resolved', rejected: 'Closed' }[r.status]}</span></div>
        <div class="meta"><span>${esc(r.reason)}${r.item ? `, ${esc(r.item)}` : ''}</span><span>${esc(r.name)}, <a href="https://wa.me/${esc(r.phone.replace(/^0/, '62'))}" target="_blank" rel="noopener">${esc(r.phone)}</a></span></div>
        <p style="margin:8px 0">${esc(r.text)}</p><div class="photos" data-ph="${esc(r.order_no)}"></div>${r.note ? `<p class="muted small">Your note: ${esc(r.note)}</p>` : ''}
        <div class="actions"><button class="btn sec" data-photos="${esc(r.order_no)}">View ${r.nimg} photo${r.nimg === 1 ? '' : 's'}</button><button class="btn" data-handle="${esc(r.order_no)}">Update status</button></div></article>`).join('')}</div>`
        : '<div class="empty">No problem reports. Customers can send one after an order is delivered.</div>'}
      <div class="head" style="margin-top:22px"><h2 style="font-size:18px">Reviews</h2></div>
      ${rv.rows.length ? `<div class="table-wrap"><table><thead><tr><th>Item</th><th>Rating</th><th>Comment</th><th>From</th><th></th></tr></thead><tbody>${rv.rows.map(r => `<tr><td>${esc(r.product_name)}</td><td style="color:#C98900;white-space:nowrap" aria-label="${r.stars} of 5">${stars(r.stars)}</td><td>${esc(r.text)}</td><td>${esc(r.name)}<div class="muted small">${esc(r.order_no)}</div></td><td><button class="linkish" data-dr="${r.id}">Remove</button></td></tr>`).join('')}</tbody></table></div>`
        : '<div class="empty">No reviews yet. Customers can rate items once their order is delivered.</div>'}`);
    $$('[data-photos]').forEach(b => (b.onclick = async () => {
      busy(b, true, 'Loading…');
      try { const { images } = await call('GET', `/api/admin/complaints/${b.dataset.photos}/images`); $(`[data-ph="${b.dataset.photos}"]`).innerHTML = images.map(i => `<a href="${i}" target="_blank" rel="noopener"><img src="${i}" alt="Customer photo" style="width:96px;height:96px;object-fit:cover;border-radius:8px;margin:0 6px 6px 0"></a>`).join(''); b.remove(); }
      catch (e) { toast(e.message, 'bad'); busy(b, false); }
    }));
    $$('[data-handle]').forEach(b => (b.onclick = () => { const r = cm.rows.find(x => x.order_no === b.dataset.handle);
      dialog(`Report on ${r.order_no}`, `${field('Status', 'status', r.status, { type: 'select', options: [['open', 'Open'], ['resolved', 'Resolved'], ['rejected', 'Closed without action']] })}${field('Note for the customer', 'note', r.note, { type: 'textarea', hint: 'they see this on their order page' })}`,
        async v => { await call('PATCH', `/api/admin/complaints/${r.order_no}`, v); toast('Saved'); feedbackView(); }); }));
    $$('[data-dr]').forEach(b => (b.onclick = async () => { if (confirm('Remove this review?')) { await call('DELETE', `/api/admin/reviews/${b.dataset.dr}`); feedbackView(); } }));
  }

  // ── platform super-admin ──
  async function superView() {
    app.innerHTML = `<header class="top"><div class="row"><h1>Platform admin</h1><button class="out" id="out">Log out</button></div></header><main><div id="view"><span class="spinner"></span></div></main>`;
    $('#out').onclick = () => logout();
    const { tenants } = await call('GET', '/api/super/tenants');
    const pend = tenants.filter(t => t.status === 'pending').length;
    view(`<div class="head"><div><h2>Stores</h2><p class="muted">${pend ? `${pend} waiting for approval` : 'No stores waiting'}.</p></div></div>
      ${tenants.length ? `<div class="table-wrap"><table><thead><tr><th>Store</th><th>Address</th><th>Signed up</th><th>Status</th><th></th></tr></thead><tbody>${tenants.sort((a, b) => (a.status === 'pending' ? -1 : 0) - (b.status === 'pending' ? -1 : 0)).map(t => `<tr>
        <td><b>${esc(t.name)}</b></td><td>${esc(t.slug)}</td><td>${new Date(t.created_at).toLocaleDateString()}</td><td><span class="pill ${t.status}">${{ active: 'Open', pending: 'Waiting', suspended: 'Suspended' }[t.status]}</span></td>
        <td style="white-space:nowrap">${t.status !== 'active' ? `<button class="btn" data-a="approve" data-id="${t.id}">Approve</button>` : `<button class="btn bad" data-a="suspend" data-id="${t.id}">Suspend</button>`}
          <button class="btn sec" data-dom="${t.id}">Custom domain</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No stores yet.</div>'}`);
    $$('[data-a]').forEach(b => (b.onclick = async () => {
      if (b.dataset.a === 'suspend' && !confirm('Suspend this store? Customers can no longer order.')) return;
      busy(b, true, '…'); try { await call('POST', `/api/super/tenants/${b.dataset.id}/${b.dataset.a}`); superView(); } catch (e) { toast(e.message, 'bad'); busy(b, false); }
    }));
    $$('[data-dom]').forEach(b => (b.onclick = () => dialog('Add a custom domain', `${field('Domain', 'host', '', { attrs: 'required placeholder="order.example.com"', hint: 'point its DNS to this platform first' })}`,
      async v => { await call('POST', `/api/super/tenants/${b.dataset.dom}/domain`, v); toast('Domain added'); })));
  }

  const VIEWS = { orders: ordersView, products: productsView, stock: stockView, feedback: feedbackView, discounts: discountsView, customers: customersView, warehouses: warehousesView, delivery: deliveryView, look: lookView, payments: paymentsView, settings: settingsView, staff: staffView };
  start();
})();
