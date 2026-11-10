// In-memory database with the same interface as db-supabase.mjs. Used by tests and `npm run dev`.
import crypto from 'node:crypto';

const UNIQUE = {
  tenants: [['slug']], tenant_domains: [['host']], users: [['tenant_id', 'email']],
  tenant_secrets: [['tenant_id', 'provider']], stock: [['warehouse_id', 'variant_id']], orders: [['tenant_id', 'no']]
};
const NO_ID = new Set(['tenant_domains', 'tenant_secrets', 'stock']);
// column defaults, mirroring the SQL migration
const DEFAULTS = {
  tenants: { theme: {}, settings: {} }, warehouses: { contact: {}, priority: 0, active: true }, products: { sort: 0, active: true },
  variants: { weight_g: 0, active: true }, stock: { qty: 0, reserved: 0 }
};

const match = (row, where) => Object.entries(where).every(([k, v]) =>
  v && typeof v === 'object' && Array.isArray(v.in) ? v.in.includes(row[k])
  : v && typeof v === 'object' && 'lt' in v ? row[k] != null && row[k] < v.lt
  : (row[k] ?? null) === (v ?? null));
const clone = x => structuredClone(x);
const norm = (t, r) => t === 'users' && r.email ? { ...r, email: String(r.email).toLowerCase() } : r;

export function memoryDb() {
  const T = {};
  const tab = t => (T[t] ||= []);
  function checkUnique(t, row, self) {
    for (const keys of UNIQUE[t] || []) {
      if (tab(t).some(r => r !== self && keys.every(k => (r[k] ?? null) === (row[k] ?? null))))
        throw Object.assign(new Error(`duplicate ${t}.${keys.join('+')}`), { code: 'duplicate' });
    }
  }
  const db = {
    async select(t, where = {}, { order, desc, limit } = {}) {
      let rows = tab(t).filter(r => match(r, where));
      if (order) rows = rows.sort((a, b) => (a[order] > b[order] ? 1 : a[order] < b[order] ? -1 : 0) * (desc ? -1 : 1));
      return clone(limit ? rows.slice(0, limit) : rows);
    },
    async one(t, where) { return (await db.select(t, where, { limit: 1 }))[0] || null; },
    async insert(t, row) {
      const r = norm(t, { ...(NO_ID.has(t) ? {} : { id: crypto.randomUUID() }), created_at: new Date().toISOString(), ...DEFAULTS[t], ...row });
      checkUnique(t, r); tab(t).push(r); return clone(r);
    },
    async update(t, where, patch) {
      const out = [];
      for (const r of tab(t)) if (match(r, where)) { const n = norm(t, { ...r, ...patch }); checkUnique(t, n, r); Object.assign(r, n); out.push(clone(r)); }
      return out;
    },
    async upsert(t, row) {
      const keys = (UNIQUE[t] || [])[0] || ['id'];
      const ex = tab(t).find(r => keys.every(k => r[k] === row[k]));
      return ex ? (await db.update(t, Object.fromEntries(keys.map(k => [k, row[k]])), row))[0] : db.insert(t, row);
    },
    async delete(t, where) { const before = tab(t).length; T[t] = tab(t).filter(r => !match(r, where)); return before - T[t].length; },
    async rpc(name, { p_tenant, p_warehouse, p_items }) {
      const rows = p_items.map(it => ({ it, s: tab('stock').find(s => s.tenant_id === p_tenant && s.warehouse_id === p_warehouse && s.variant_id === it.variant_id) }));
      if (name === 'reserve_stock') {
        if (rows.some(({ it, s }) => !s || s.qty - s.reserved < it.qty)) throw Object.assign(new Error('out_of_stock'), { code: 'out_of_stock' });
        rows.forEach(({ it, s }) => { s.reserved += it.qty; });
      } else if (name === 'release_stock') rows.forEach(({ it, s }) => { if (s) s.reserved = Math.max(s.reserved - it.qty, 0); });
      else if (name === 'commit_stock') rows.forEach(({ it, s }) => { if (s) { s.qty = Math.max(s.qty - it.qty, 0); s.reserved = Math.max(s.reserved - it.qty, 0); } });
      else throw new Error('unknown rpc ' + name);
      return true;
    },
    _tables: T
  };
  return db;
}
