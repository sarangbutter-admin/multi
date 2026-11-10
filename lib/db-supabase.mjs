// Supabase (PostgREST) database using only fetch. The secret key lives in server env vars only.
const UPSERT_KEYS = { tenant_secrets: 'tenant_id,provider', stock: 'warehouse_id,variant_id', tenant_domains: 'host' };

export function supabaseDb({ url, key, fetch: f = fetch }) {
  const base = String(url).replace(/\/+$/, '') + '/rest/v1/';
  const hdr = (extra = {}) => ({ apikey: key, ...(String(key).startsWith('eyJ') ? { authorization: 'Bearer ' + key } : {}), 'content-type': 'application/json', ...extra });
  const val = v => (v === null || v === undefined ? 'is.null' : v === true || v === false ? 'is.' + v : 'eq.' + encodeURIComponent(v));
  const filt = where => Object.entries(where).map(([k, v]) =>
    v && typeof v === 'object' && Array.isArray(v.in) ? `${k}=in.(${v.in.map(x => `"${String(x).replace(/"/g, '')}"`).join(',')})`
    : v && typeof v === 'object' && 'lt' in v ? `${k}=lt.${encodeURIComponent(v.lt)}`
    : `${k}=${val(v)}`).join('&');
  async function go(method, path, body, extra) {
    const r = await f(base + path, { method, headers: hdr(extra), body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    if (!r.ok) {
      if (text.includes('out_of_stock')) throw Object.assign(new Error('out_of_stock'), { code: 'out_of_stock' });
      if (r.status === 409 || text.includes('23505')) throw Object.assign(new Error('duplicate'), { code: 'duplicate' });
      throw new Error(`Supabase ${method} ${path.split('?')[0]} failed (${r.status}): ${text.slice(0, 200)}`);
    }
    return text ? JSON.parse(text) : null;
  }
  const db = {
    select: (t, where = {}, { order, desc, limit } = {}) =>
      go('GET', `${t}?select=*&${filt(where)}${order ? `&order=${order}.${desc ? 'desc' : 'asc'}` : ''}${limit ? `&limit=${limit}` : ''}`),
    async one(t, where) { return (await db.select(t, where, { limit: 1 }))[0] || null; },
    async insert(t, row) { return (await go('POST', t, row, { prefer: 'return=representation' }))[0]; },
    update: (t, where, patch) => go('PATCH', `${t}?${filt(where)}`, patch, { prefer: 'return=representation' }),
    async upsert(t, row) {
      const on = UPSERT_KEYS[t] ? `?on_conflict=${UPSERT_KEYS[t]}` : '';
      return (await go('POST', t + on, row, { prefer: 'resolution=merge-duplicates,return=representation' }))[0];
    },
    async delete(t, where) { return (await go('DELETE', `${t}?${filt(where)}`, undefined, { prefer: 'return=representation' })).length; },
    rpc: (name, args) => go('POST', 'rpc/' + name, args)
  };
  return db;
}
