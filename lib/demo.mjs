// Sample stores for `npm run dev` and for a demo site without a database (DEMO_MODE=1 on Netlify).
//   shop: /?store=sarang  ·  /?store=daily-mart  ·  /?store=your-store (unlisted, plain theme)
//   back office /admin: store address "sarang", owner@sarang.test / demo-password-1; leave the address empty for admin@demo.test / demo-admin-pass
//   business login corner.shop / demo-password-1, coupon WELCOME10
import { mkCred } from './crypto.mjs';

export const DEMO_ENV = { SESSION_SECRET: 'demo-session-secret-0123456789abcdef', MASTER_KEY: 'demo-master-key-0123456789abcdef0123', SUPER_SETUP_KEY: 'demo-setup-key-123456' };

export async function seedDemo(db) {
  await db.insert('users', { tenant_id: null, email: 'admin@demo.test', role: 'super', cred: await mkCred('demo-admin-pass') });
  const mk = async (slug, name, theme, about) => {
    const t = await db.insert('tenants', { slug, name, status: 'active', theme, settings: { payments: ['manual'], pickup: true, pay_minutes: 60, about, whatsapp: '6281200000000', tiers: { regular: { qty: 10, amt: 0, pct: 5 }, b2b: { qty: 1, amt: 0, pct: 15 } }, manual: { bank: 'BCA', account_no: '1234567890', account_name: name } } });
    await db.insert('users', { tenant_id: t.id, email: `owner@${slug}.test`, name: 'Owner', role: 'owner', cred: await mkCred('demo-password-1') });
    return t;
  };
  const sarang = await mk('sarang', 'Fresh Basket', {}, 'Fresh produce, dairy and pantry staples, delivered the same day.');
  const kopi = await mk('daily-mart', 'Daily Mart', {}, 'Everyday groceries from your neighbourhood market.');
  const wj = await db.insert('warehouses', { tenant_id: sarang.id, name: 'Store Jakarta', address: 'Jl. Kemang Raya 10', postal_code: '12730', lat: -6.2615, lng: 106.8106 });
  const wb = await db.insert('warehouses', { tenant_id: sarang.id, name: 'Store Bandung', address: 'Jl. Braga 5', postal_code: '40111', lat: -6.9175, lng: 107.6191 });
  const menu = [['Bananas', 'Fresh produce', [['500 g', 14000, 500], ['1 kg', 26000, 1000]], 'bananas'], ['Tomatoes', 'Fresh produce', [['500 g', 12000, 500]], 'tomatoes'],
    ['Apples', 'Fresh produce', [['4 pieces', 32000, 700]], 'apples'], ['Baby spinach', 'Fresh produce', [['200 g bag', 16000, 200]], 'spinach'],
    ['Fresh milk', 'Dairy and eggs', [['1 litre', 24000, 1050], ['2 litres', 45000, 2100]], 'milk'], ['Free-range eggs', 'Dairy and eggs', [['Tray of 10', 30000, 650], ['Tray of 30', 85000, 1900]], 'eggs'],
    ['Jasmine rice', 'Pantry', [['2 kg', 36000, 2000], ['5 kg', 85000, 5000]], 'rice'], ['Spaghetti', 'Pantry', [['500 g', 18000, 500]], 'spaghetti'],
    ['Cooking oil', 'Pantry', [['1 litre', 22000, 920]], 'oil'], ['Orange juice', 'Drinks', [['1 litre', 28000, 1050]], 'juice'],
    ['Sparkling water', 'Drinks', [['6 x 330 ml', 36000, 2100]], 'water'], ['Potato chips', 'Snacks', [['Family pack', 19000, 180]], 'chips']];
  for (const [i, [name, category, vs, img]] of menu.entries()) {
    const p = await db.insert('products', { tenant_id: sarang.id, name, category, sort: i, image: `/demo/${img}.svg`, description: `${name}, picked fresh and packed to order.` });
    for (const [vn, price, weight_g] of vs) {
      const v = await db.insert('variants', { tenant_id: sarang.id, product_id: p.id, name: vn, price, weight_g });
      const few = { 'Free-range eggs': 3, 'Sparkling water': 0 }[name];  // to show "Only 3 left" and "Sold out"
      await db.insert('stock', { tenant_id: sarang.id, warehouse_id: wj.id, variant_id: v.id, qty: few ?? 40, reserved: 0 });
      await db.insert('stock', { tenant_id: sarang.id, warehouse_id: wb.id, variant_id: v.id, qty: few ?? (name === 'Baby spinach' ? 0 : 60), reserved: 0 });
    }
  }
  const wk = await db.insert('warehouses', { tenant_id: kopi.id, name: 'Daily Mart Tebet', address: 'Jl. Tebet Barat 3', postal_code: '12810', lat: -6.2386, lng: 106.8527 });
  for (const [name, category, price, img] of [['Bananas', 'Fresh produce', 14000, 'bananas'], ['Fresh milk', 'Dairy and eggs', 24000, 'milk'], ['Jasmine rice', 'Pantry', 36000, 'rice']]) {
    const p = await db.insert('products', { tenant_id: kopi.id, name, category, image: `/demo/${img}.svg`, description: `${name}, from the shelf to your door.` });
    const v = await db.insert('variants', { tenant_id: kopi.id, product_id: p.id, name: 'Standard', price, weight_g: 1000 });
    await db.insert('stock', { tenant_id: kopi.id, warehouse_id: wk.id, variant_id: v.id, qty: 30, reserved: 0 });
  }
  // a neutral, unlisted store used for theme library pictures: /?store=your-store
  const demo = await mk('your-store', 'Your Store', {}, 'Fresh groceries and everyday essentials, ready for pick up or delivery.');
  await db.update('tenants', { id: demo.id }, { settings: { ...demo.settings, listed: false } });
  const wd = await db.insert('warehouses', { tenant_id: demo.id, name: 'Main store', address: 'Jl. Contoh 1', postal_code: '10110', lat: -6.2, lng: 106.82 });
  for (const { id: pid, ...p } of await db.select('products', { tenant_id: sarang.id })) {
    const np = await db.insert('products', { ...p, tenant_id: demo.id, description: p.name + ', picked fresh.' });
    for (const { id: vid, ...v } of await db.select('variants', { product_id: pid })) {
      const nv = await db.insert('variants', { ...v, tenant_id: demo.id, product_id: np.id });
      const st = await db.one('stock', { warehouse_id: wj.id, variant_id: vid });
      await db.insert('stock', { tenant_id: demo.id, warehouse_id: wd.id, variant_id: nv.id, qty: st ? st.qty : 10, reserved: 0 });
    }
  }
  await db.insert('coupons', { tenant_id: sarang.id, code: 'WELCOME10', type: 'pct', value: 10, min_purchase: 100000, max_uses: 100 });
  await db.insert('coupons', { tenant_id: sarang.id, code: 'FIVEK', type: 'amt', value: 5000 });
  await db.insert('b2b_accounts', { tenant_id: sarang.id, name: 'Corner Shop', phone: '0811000111', login: 'corner.shop', cred: await mkCred('demo-password-1') });
  await db.insert('courier_zones', { tenant_id: sarang.id, name: 'Nearby', max_km: 8, fee: 12000, eta: '45–90 minutes' });
  await db.insert('courier_zones', { tenant_id: sarang.id, name: 'City', max_km: 25, fee: 25000, eta: 'Same day' });
}
