// Pricing, warehouse selection and store-courier zones. Pure functions: no database, easy to test.

const E = (status, code, msg) => Object.assign(new Error(msg || code), { status, code });

export function haversineKm(a, b) {
  if ([a?.lat, a?.lng, b?.lat, b?.lng].some(v => typeof v !== 'number' || !isFinite(v))) return null;
  const R = 6371, rad = x => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Cart from the phone → trusted lines. Prices always come from the database, never from the request.
export function buildItems(raw, variants, products) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 50) throw E(400, 'bad_cart', 'Cart is empty or too large');
  const vMap = new Map(variants.map(v => [v.id, v])), pMap = new Map(products.map(p => [p.id, p]));
  const merged = new Map();
  for (const it of raw) {
    const qty = Number(it?.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) throw E(400, 'bad_qty', 'Invalid quantity');
    merged.set(it.variant_id, (merged.get(it.variant_id) || 0) + qty);
  }
  const items = [...merged].map(([id, qty]) => {
    const v = vMap.get(id), p = v && pMap.get(v.product_id);
    if (!v || !v.active || !p || !p.active) throw E(400, 'unavailable', 'An item in your cart is no longer available');
    if (qty > 99) throw E(400, 'bad_qty', 'Invalid quantity');
    return { variant_id: v.id, product_id: p.id, label: v.name && v.name !== p.name ? `${p.name} – ${v.name}` : p.name, price: Number(v.price), qty, weight_g: v.weight_g || 0 };
  });
  return { items, subtotal: items.reduce((s, i) => s + i.price * i.qty, 0) };
}

// Choose the warehouse that can ship the WHOLE order: closest first, then priority, then name.
export function pickWarehouse(warehouses, stockRows, items, dest) {
  const avail = new Map(stockRows.map(s => [s.warehouse_id + '|' + s.variant_id, s.qty - s.reserved]));
  const ok = warehouses.filter(w => w.active && items.every(i => (avail.get(w.id + '|' + i.variant_id) || 0) >= i.qty))
    .map(w => ({ warehouse: w, distanceKm: haversineKm(w, dest) }))
    .sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity) || (b.warehouse.priority || 0) - (a.warehouse.priority || 0) || String(a.warehouse.name).localeCompare(b.warehouse.name));
  return ok[0] || null;
}

// Total sellable units per variant across all active warehouses (for "sold out" badges in the app).
export function availability(warehouses, stockRows) {
  const live = new Set(warehouses.filter(w => w.active).map(w => w.id)), out = {};
  for (const s of stockRows) if (live.has(s.warehouse_id)) out[s.variant_id] = (out[s.variant_id] || 0) + Math.max(s.qty - s.reserved, 0);
  return out;
}

// Store's own courier: the smallest zone that reaches the customer from this warehouse.
export function storeCourierOption(zones, warehouseId, distanceKm) {
  if (distanceKm == null) return null;
  const z = zones.filter(z => (z.warehouse_id == null || z.warehouse_id === warehouseId) && distanceKm <= Number(z.max_km))
    .sort((a, b) => Number(a.max_km) - Number(b.max_km) || (a.warehouse_id ? -1 : 1))[0];
  return z ? { id: 'store:' + z.id, provider: 'store', courier: 'store', service: z.name, label: `Store courier – ${z.name}`, fee: Number(z.fee), eta: z.eta || '' } : null;
}
