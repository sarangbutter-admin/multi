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
      <p class="switch muted">New here? <button class="linkish" id="to-signup">Open a store</button></p><div id="demo-hint"></div></main>`;
    $('#to-signup').onclick = showSignup;
    api('GET', '/api/platform').then(p => { if (p.demo && $('#demo-hint')) $('#demo-hint').innerHTML = `<div class="panel demo-hint"><b>Demo site</b><p class="small">Sample data, reset from time to time. Try:</p>
      <p class="small">Store owner: store address <code>sarang</code>, <code>owner@sarang.test</code>, password <code>demo-password-1</code></p>
      <p class="small">Platform admin: leave the store address empty, <code>admin@demo.test</code>, password <code>demo-admin-pass</code></p></div>`; }).catch(() => {});
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

  // ── look: theme library + settings of the active theme with a live preview of the real shop ──
  const THEME_STATUS = { private: ['Only your store', ''], review: ['Waiting for review', 'pending'], public: ['In the theme store', 'active'], rejected: ['Not accepted', 'suspended'] };
  const b64 = buf => { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
  function saveB64(name, data) {
    const bin = atob(data), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([u], { type: 'application/zip' })); a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  const shopUrl = (extra = '') => `/?store=${encodeURIComponent(A.auth.slug)}&preview=1${extra}`;
  const thumb = t => t.preview ? `<img src="${esc(t.preview)}" alt="">` : `<span>${esc(t.name.slice(0, 1))}</span>`;

  async function lookView() {
    const [lib, cur] = await Promise.all([call('GET', '/api/admin/themes'), call('GET', '/api/admin/themes/' + encodeURIComponent(A.store.theme_ref || 'market'))]);
    const active = lib.themes.find(t => t.ref === lib.current) || cur.theme, schema = cur.settings, vals = { ...cur.values };
    const groups = []; for (const s of schema) { if (s.type === 'header' || !groups.length) groups.push({ label: s.type === 'header' ? s.label : 'Settings', items: [] }); if (s.type !== 'header') groups.at(-1).items.push(s); }
    const input = s => {
      const v = vals[s.id] ?? s.default, hint = s.info ? `<small class="hint-line">${esc(s.info)}</small>` : '';
      if (s.type === 'color') return `<label class="sw"><input type="color" name="${s.id}" value="${esc(v)}"><span>${esc(s.label)}<code>${esc(String(v).toUpperCase())}</code></span></label>`;
      if (s.type === 'checkbox') return field(s.label, s.id, v, { type: 'checkbox', hint: s.info });
      if (s.type === 'range') return `<label class="f"><span>${esc(s.label)} <output class="hint" data-for="${s.id}">${esc(v)}</output></span><input type="range" name="${s.id}" min="${s.min}" max="${s.max}" step="${s.step}" value="${esc(v)}">${hint}</label>`;
      if (s.type === 'select') return field(s.label, s.id, v, { type: 'select', options: s.options.map(o => [o.value, o.label]) }) + hint;
      if (s.type === 'font') return field(s.label, s.id, v, { type: 'select', options: A.store.fonts.map(f => [f, f]) }) + hint;
      if (s.type === 'textarea') return field(s.label, s.id, v, { type: 'textarea', rows: 2, attrs: 'maxlength="1000"' }) + hint;
      if (s.type === 'image') { const own = String(v).startsWith('asset:'); return `<label class="f"><span>${esc(s.label)}</span><input name="${s.id}" value="${own ? '' : esc(v)}" data-asset="${own ? esc(v) : ''}" placeholder="${own ? "Using the theme's picture. Paste a link to use yours" : 'https://'}" inputmode="url" autocomplete="off">${hint}${String(s.default).startsWith('asset:') ? `<span class="img-acts"><button type="button" class="linkish small" data-reset="${s.id}">Use the theme's picture</button><button type="button" class="linkish small" data-none="${s.id}">No picture</button></span>` : ''}</label>`; }
      return field(s.label, s.id, v, { attrs: 'maxlength="200"' }) + hint;
    };
    view(`<div class="head"><div><h2>Look</h2><p class="muted">Pick a theme for your shop, then change its colours, pictures and words. The preview is your real shop.</p></div></div>
      <section class="panel theme-now">
        <div class="tthumb">${thumb(active)}</div>
        <div><div class="muted small">Your theme</div><h3>${esc(active.name)} <span class="muted small">v${esc(active.version)}</span></h3>
          <p class="muted small">${esc(active.description || '')}</p>
          <p class="small">${active.builtin ? 'Made by the platform' : active.mine ? 'Uploaded by your store' : `Shared by ${esc(active.store || active.author || 'another store')}`}</p></div>
      </section>
      <div class="look">
        <form class="panel" id="lf">${groups.map(g => `<fieldset class="tgroup"><legend>${esc(g.label)}</legend>${g.items.some(i => i.type === 'color') ? `<div class="swatches">${g.items.filter(i => i.type === 'color').map(input).join('')}</div>` : ''}${g.items.filter(i => i.type !== 'color').map(input).join('')}</fieldset>`).join('')}
          <div class="actions sticky-actions"><button class="btn">Save look</button><button type="button" class="btn sec" id="reset">Undo changes</button></div></form>
        <div class="preview-col">
          <div class="seg-mini" role="group" aria-label="Preview size"><button type="button" data-size="phone" aria-pressed="true">Phone</button><button type="button" data-size="desk" aria-pressed="false">Computer</button><a class="linkish small" href="${shopUrl()}" target="_blank" rel="noopener">Open in a new tab</a></div>
          <div class="pv-frame phone" id="pvf"><iframe id="pv" title="Preview of your shop" src="${shopUrl()}"></iframe></div>
        </div>
      </div>
      <div class="head" style="margin-top:28px"><div><h2>Theme library</h2><p class="muted">Built-in themes, themes other stores share, and your own uploads.</p></div>
        <label class="btn" tabindex="0">Upload a theme (.zip)<input type="file" id="tz" accept=".zip,application/zip" hidden></label></div>
      <p class="muted small" style="margin-top:-6px">To make your own: download any theme below, change its files, zip the folder and upload it. Themes can change layout, colours and pictures; they can't run scripts or touch payments.</p>
      <div class="themes">${lib.themes.map(t => {
        const st = THEME_STATUS[t.status] || ['', ''], on = t.ref === lib.current;
        return `<article class="tcard${on ? ' on' : ''}"><div class="tthumb">${thumb(t)}</div><div class="tbody">
          <h3>${esc(t.name)} <span class="muted small">v${esc(t.version)}</span></h3>
          <p class="muted small">${t.builtin ? 'Built in' : t.mine ? 'Your upload' : `By ${esc(t.store || t.author || 'another store')}`}${t.description ? ' · ' + esc(t.description) : ''}</p>
          ${t.mine ? `<span class="pill ${st[1]}">${st[0]}</span>${t.status === 'rejected' && t.review_note ? `<p class="small err-note">${esc(t.review_note)}</p>` : ''}` : ''}
          <div class="tact">${on ? '<span class="pill active">In use</span>' : `<button class="btn" data-use="${esc(t.ref)}">Use this theme</button><button class="btn sec" data-pre="${esc(t.ref)}">Preview</button>`}
            <button class="btn sec" data-dl="${esc(t.ref)}">Download</button>
            ${t.mine && ['private', 'rejected'].includes(t.status) ? `<button class="btn sec" data-share="${esc(t.ref)}">Share in the theme store</button>` : ''}
            ${t.mine && ['review', 'public'].includes(t.status) ? `<button class="btn sec" data-unshare="${esc(t.ref)}">Stop sharing</button>` : ''}
            ${t.mine ? `<button class="btn bad" data-del="${esc(t.ref)}">Delete</button>` : ''}</div></div></article>`;
      }).join('')}</div>`);

    // live preview: the shop in the frame listens for new values
    const f = $('#lf'), pv = $('#pv');
    const collect = () => { const out = {}; for (const s of schema) { if (!s.id || !f.elements[s.id]) continue; const el = f.elements[s.id]; out[s.id] = s.type === 'checkbox' ? el.checked : s.type === 'range' ? Number(el.value) : s.type === 'image' ? el.value.trim() || el.dataset.asset || '' : el.value.trim(); } return out; };
    const push = () => pv.contentWindow && pv.contentWindow.postMessage({ type: 'so-theme', values: collect() }, location.origin);
    let t0; f.oninput = e => {
      $$('.sw', f).forEach(sw => ($('code', sw).textContent = $('input', sw).value.toUpperCase()));
      $$('output[data-for]', f).forEach(o => (o.textContent = f.elements[o.dataset.for].value));
      clearTimeout(t0); t0 = setTimeout(push, e.target.type === 'color' || e.target.type === 'range' ? 30 : 250);
    };
    f.onchange = push; pv.onload = push;
    const setImg = (id, asset) => { const el = f.elements[id]; el.value = ''; el.dataset.asset = asset; el.placeholder = asset ? "Using the theme's picture. Paste a link to use yours" : 'No picture. Paste a link to add one'; push(); };
    $$('[data-reset]', f).forEach(b => (b.onclick = () => setImg(b.dataset.reset, schema.find(x => x.id === b.dataset.reset).default)));
    $$('[data-none]', f).forEach(b => (b.onclick = () => setImg(b.dataset.none, '')));
    $$('input[data-asset]', f).forEach(el => el.addEventListener('input', () => { if (el.value.trim()) el.dataset.asset = ''; }));
    $$('.seg-mini [data-size]').forEach(b => (b.onclick = () => { $$('.seg-mini [data-size]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); $('#pvf').className = 'pv-frame ' + b.dataset.size; fitPreview(); }));
    $('#reset').onclick = () => lookView();
    bindForm(f, async () => { A.store.theme = (await call('PUT', '/api/admin/theme', collect())).theme; }, 'Look saved. Customers see it on their next visit.');
    fitPreview(); addEventListener('resize', fitPreview);

    // library actions
    const act = (sel, fn) => $$(sel).forEach(b => (b.onclick = async () => { busy(b, true, '…'); try { await fn(b); } catch (e) { toast(e.message, 'bad'); busy(b, false); } }));
    act('[data-use]', async b => {
      if (!confirm("Switch to this theme? Your shop starts with the theme's own colours and words, and you can change them here afterwards.")) return busy(b, false);
      await call('POST', `/api/admin/themes/${b.dataset.use}/use`); A.store = await call('GET', '/api/admin/store'); toast('Theme changed. Pick your colours below.'); lookView();
    });
    act('[data-dl]', async b => { const r = await call('GET', `/api/admin/themes/${b.dataset.dl}/download`); saveB64(r.filename, r.zip); busy(b, false); });
    act('[data-share]', async b => { await call('POST', `/api/admin/themes/${b.dataset.share}/submit`); toast('Sent for review. It appears in the theme store once approved.'); lookView(); });
    act('[data-unshare]', async b => { await call('POST', `/api/admin/themes/${b.dataset.unshare}/withdraw`); toast('No longer shared. Stores already using it keep it.'); lookView(); });
    act('[data-del]', async b => {
      if (!confirm('Delete this theme? Any store using it goes back to the Bold theme.')) return busy(b, false);
      await call('DELETE', `/api/admin/themes/${b.dataset.del}`); A.store = await call('GET', '/api/admin/store'); toast('Theme deleted'); lookView();
    });
    $$('[data-pre]').forEach(b => (b.onclick = () => {
      dlg.innerHTML = `<form method="dialog" class="pre-dlg"><div class="key-head"><h3>Preview</h3><button type="button" class="btn sec" data-close>Close</button></div>
        <p class="muted small">Your products in this theme, with its own colours. Nothing changes for customers until you choose "Use this theme".</p>
        <div class="pv-frame phone big"><iframe title="Theme preview" src="${shopUrl('&defaults=1&theme=' + encodeURIComponent(b.dataset.pre))}"></iframe></div>
        <label class="check" style="margin-top:12px"><input type="checkbox" id="keep-look"><span>Keep my current colours and font<small>Off: start from this theme's own look and change it afterwards</small></span></label>
        <div class="actions"><button type="button" class="btn" data-go>Use this theme</button></div></form>`;
      $('[data-close]', dlg).onclick = () => dlg.close();
      $('[data-go]', dlg).onclick = async e => { busy(e.target, true, '…'); try { await call('POST', `/api/admin/themes/${b.dataset.pre}/use`, { keep_look: $('#keep-look', dlg).checked }); dlg.close(); A.store = await call('GET', '/api/admin/store'); toast('Theme changed. Your shop uses it now.'); lookView(); } catch (err) { toast(err.message, 'bad'); busy(e.target, false); } };
      dlg.showModal();
    }));
    const up = $('label:has(#tz)'); up.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#tz').click(); } };
    $('#tz').onchange = async e => {
      const file = e.target.files[0]; e.target.value = ''; if (!file) return;
      if (file.size > 3e6) return toast('That .zip is bigger than 3 MB. Make the pictures smaller.', 'bad');
      toast('Checking your theme…');
      try { const r = await call('POST', '/api/admin/themes', { zip: b64(await file.arrayBuffer()) }); toast(r.replaced ? `${r.theme.name} updated` : `${r.theme.name} added. Choose "Use this theme" to switch.`); lookView(); }
      catch (err) { dialog("This theme can't be added", `<p>${esc(err.message)}</p><p class="muted small">Fix it in the theme's files, zip them again and upload.</p>`, async () => {}, { submit: 'OK' }); }
    };
  }
  // the preview frame shows a 390px phone or a 1280px computer screen, scaled to fit
  function fitPreview() {
    const box = $('#pvf'); if (!box) return;
    const fr = $('iframe', box), desk = box.classList.contains('desk'), w = desk ? 1280 : 390, h = desk ? 900 : 780, k = Math.min(1, (box.clientWidth || w) / w);
    Object.assign(fr.style, { width: w + 'px', height: h + 'px', transform: `scale(${k})` }); box.style.height = h * k + 'px';
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
  async function superView(tab = A.superTab || 'stores') {
    A.superTab = tab;
    app.innerHTML = `<header class="top"><div class="row"><h1>Platform admin</h1><button class="out" id="out">Log out</button></div>
      <nav class="tabs" aria-label="Sections"><button data-st="stores">Stores</button><button data-st="themes">Theme store<span class="count" id="tq" hidden></span></button></nav></header><main><div id="view"><span class="spinner"></span></div></main>`;
    $('#out').onclick = () => logout();
    $$('[data-st]').forEach(b => { if (b.dataset.st === tab) b.setAttribute('aria-current', 'page'); b.onclick = () => superView(b.dataset.st); });
    const themes = await call('GET', '/api/super/themes'), waiting = themes.themes.filter(t => t.status === 'review').length;
    if (waiting) { $('#tq').hidden = false; $('#tq').textContent = waiting; }
    return tab === 'themes' ? superThemes(themes) : superStores();
  }
  async function superStores() {
    const { tenants } = await call('GET', '/api/super/tenants');
    const pend = tenants.filter(t => t.status === 'pending').length;
    view(`<div class="head"><div><h2>Stores</h2><p class="muted">${pend ? `${pend} waiting for approval` : 'No stores waiting'}.</p></div></div>
      ${tenants.length ? `<div class="table-wrap"><table><thead><tr><th>Store</th><th>Address</th><th>Signed up</th><th>Status</th><th></th></tr></thead><tbody>${tenants.sort((a, b) => (a.status === 'pending' ? -1 : 0) - (b.status === 'pending' ? -1 : 0)).map(t => `<tr>
        <td><b>${esc(t.name)}</b></td><td>${esc(t.slug)}</td><td>${new Date(t.created_at).toLocaleDateString()}</td><td><span class="pill ${t.status}">${{ active: 'Open', pending: 'Waiting', suspended: 'Suspended' }[t.status]}</span></td>
        <td style="white-space:nowrap">${t.status !== 'active' ? `<button class="btn" data-a="approve" data-id="${t.id}">Approve</button>` : `<button class="btn bad" data-a="suspend" data-id="${t.id}">Suspend</button>`}
          <button class="btn sec" data-dom="${t.id}">Custom domain</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No stores yet.</div>'}`);
    $$('[data-a]').forEach(b => (b.onclick = async () => {
      if (b.dataset.a === 'suspend' && !confirm('Suspend this store? Customers can no longer order.')) return;
      busy(b, true, '…'); try { await call('POST', `/api/super/tenants/${b.dataset.id}/${b.dataset.a}`); superView('stores'); } catch (e) { toast(e.message, 'bad'); busy(b, false); }
    }));
    $$('[data-dom]').forEach(b => (b.onclick = () => dialog('Add a custom domain', `${field('Domain', 'host', '', { attrs: 'required placeholder="order.example.com"', hint: 'point its DNS to this platform first' })}`,
      async v => { await call('POST', `/api/super/tenants/${b.dataset.dom}/domain`, v); toast('Domain added'); })));
  }
  function superThemes({ themes, preview_store }) {
    const order = { review: 0, public: 1, rejected: 2 };
    view(`<div class="head"><div><h2>Theme store</h2><p class="muted">Themes stores want to share. Approved themes show up in every store's theme library. Themes are checked for scripts and outside links when they're uploaded; here you judge whether they look right.</p></div></div>
      ${themes.length ? `<div class="themes">${themes.sort((a, b) => order[a.status] - order[b.status]).map(t => `<article class="tcard"><div class="tthumb">${thumb(t)}</div><div class="tbody">
        <h3>${esc(t.name)} <span class="muted small">v${esc(t.version)}</span></h3>
        <p class="muted small">From ${esc(t.store || 'a deleted store')}${t.author ? ` · made by ${esc(t.author)}` : ''}${t.description ? ' · ' + esc(t.description) : ''}</p>
        <span class="pill ${(THEME_STATUS[t.status] || [])[1]}">${{ review: 'Waiting for review', public: 'In the theme store', rejected: 'Not accepted' }[t.status]}</span>
        ${t.review_note ? `<p class="small err-note">${esc(t.review_note)}</p>` : ''}
        <div class="tact">${preview_store ? `<a class="btn sec" href="/?store=${encodeURIComponent(preview_store)}&theme=${encodeURIComponent(t.ref)}" target="_blank" rel="noopener">Preview</a>` : ''}
          <button class="btn sec" data-dl="${esc(t.ref)}">Download</button>
          ${t.status !== 'public' ? `<button class="btn" data-ok="${esc(t.ref)}">Approve</button>` : ''}
          ${t.status !== 'rejected' ? `<button class="btn bad" data-no="${esc(t.ref)}">${t.status === 'public' ? 'Remove from store' : 'Turn down'}</button>` : ''}</div></div></article>`).join('')}</div>`
        : '<div class="empty">No themes have been shared yet.</div>'}`);
    $$('[data-dl]').forEach(b => (b.onclick = async () => { try { const r = await call('GET', `/api/super/themes/${b.dataset.dl}/download`); saveB64(r.filename, r.zip); } catch (e) { toast(e.message, 'bad'); } }));
    $$('[data-ok]').forEach(b => (b.onclick = async () => { busy(b, true, '…'); try { await call('POST', `/api/super/themes/${b.dataset.ok}/approve`); toast('Approved. It is in the theme store now.'); superView('themes'); } catch (e) { toast(e.message, 'bad'); busy(b, false); } }));
    $$('[data-no]').forEach(b => (b.onclick = () => dialog('Turn down this theme', field('Note for the store', 'note', '', { type: 'textarea', hint: 'what to fix', attrs: 'maxlength="300" required' }),
      async v => { await call('POST', `/api/super/themes/${b.dataset.no}/reject`, v); toast('The store can see your note'); superView('themes'); }, { submit: 'Send' })));
  }

  const VIEWS = { orders: ordersView, products: productsView, stock: stockView, feedback: feedbackView, discounts: discountsView, customers: customersView, warehouses: warehousesView, delivery: deliveryView, look: lookView, payments: paymentsView, settings: settingsView, staff: staffView };
  start();
})();
