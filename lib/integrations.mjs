// Third-party integrations. Every function takes the tenant's own keys and an injectable fetch (for tests).
import crypto from 'node:crypto';
import { safeEq } from './crypto.mjs';

const json = async (r, what) => {
  const t = await r.text(); let d; try { d = t ? JSON.parse(t) : {}; } catch { d = { raw: t.slice(0, 300) }; }
  if (!r.ok) throw Object.assign(new Error(`${what} failed (${r.status})`), { code: 'provider_error', detail: d });
  return d;
};

// ── Cloudflare Turnstile ──────────────────────────────────────────────────────────────────────────
export async function verifyTurnstile({ secret, token, ip, fetch: f = fetch }) {
  if (!secret) return { ok: true, skipped: true };            // tenant hasn't enabled Turnstile
  if (!token) return { ok: false };
  const body = new URLSearchParams({ secret, response: String(token) }); if (ip) body.set('remoteip', ip);
  const r = await f('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
  const d = await r.json().catch(() => ({}));
  return { ok: d.success === true, hostname: d.hostname };
}

// ── Midtrans Snap ─────────────────────────────────────────────────────────────────────────────────
const mtBase = prod => (prod ? 'https://app.midtrans.com' : 'https://app.sandbox.midtrans.com');
export async function midtransCreate({ keys, order, finishUrl, fetch: f = fetch }) {
  const body = {
    transaction_details: { order_id: order.ref, gross_amount: order.total },
    item_details: [...order.items.map(i => ({ id: i.variant_id.slice(0, 50), name: i.label.slice(0, 50), price: i.price, quantity: i.qty })),
                   ...(order.shipping_fee ? [{ id: 'shipping', name: 'Shipping', price: order.shipping_fee, quantity: 1 }] : [])],
    customer_details: { first_name: order.customer.name, phone: order.customer.phone, email: order.customer.email || undefined },
    ...(finishUrl ? { callbacks: { finish: finishUrl } } : {}),
    expiry: { unit: 'minute', duration: order.payMinutes }
  };
  const r = await f(mtBase(keys.production) + '/snap/v1/transactions', {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: 'Basic ' + Buffer.from(keys.serverKey + ':').toString('base64') }
  });
  const d = await json(r, 'Midtrans');
  return { url: d.redirect_url, token: d.token };
}
// signature_key = SHA512(order_id + status_code + gross_amount + serverKey)
export function midtransVerify(body, serverKey) {
  if (!body || !body.signature_key) return false;
  const s = crypto.createHash('sha512').update(String(body.order_id) + body.status_code + body.gross_amount + serverKey).digest('hex');
  return safeEq(s, body.signature_key);
}
export function midtransStatus(b) {
  if (b.transaction_status === 'settlement' || (b.transaction_status === 'capture' && (b.fraud_status || 'accept') === 'accept')) return 'paid';
  if (['expire', 'cancel', 'deny', 'failure'].includes(b.transaction_status)) return 'failed';
  return 'pending';
}

// ── DOKU Checkout (non-SNAP signature) ────────────────────────────────────────────────────────────
const dokuBase = prod => (prod ? 'https://api.doku.com' : 'https://api-sandbox.doku.com');
export function dokuSignature({ clientId, secretKey, requestId, timestamp, target, body }) {
  const lines = [`Client-Id:${clientId}`, `Request-Id:${requestId}`, `Request-Timestamp:${timestamp}`, `Request-Target:${target}`];
  if (body !== undefined) lines.push(`Digest:${crypto.createHash('sha256').update(body).digest('base64')}`);
  return 'HMACSHA256=' + crypto.createHmac('sha256', secretKey).update(lines.join('\n')).digest('base64');
}
export async function dokuCreate({ keys, order, notifyUrl, finishUrl, fetch: f = fetch, now = new Date() }) {
  const target = '/checkout/v1/payment';
  const body = JSON.stringify({
    order: { amount: order.total, invoice_number: order.ref, ...(finishUrl ? { callback_url: finishUrl } : {}),
             line_items: order.items.map(i => ({ name: i.label.slice(0, 64), price: i.price, quantity: i.qty })).concat(order.shipping_fee ? [{ name: 'Shipping', price: order.shipping_fee, quantity: 1 }] : []) },
    payment: { payment_due_date: order.payMinutes },
    customer: { name: order.customer.name, phone: order.customer.phone, ...(order.customer.email ? { email: order.customer.email } : {}) },
    ...(notifyUrl ? { additional_info: { override_notification_url: notifyUrl } } : {})
  });
  const requestId = crypto.randomUUID(), timestamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const r = await f(dokuBase(keys.production) + target, {
    method: 'POST', body,
    headers: { 'content-type': 'application/json', 'Client-Id': keys.clientId, 'Request-Id': requestId, 'Request-Timestamp': timestamp,
               Signature: dokuSignature({ clientId: keys.clientId, secretKey: keys.secretKey, requestId, timestamp, target, body }) }
  });
  const d = await json(r, 'DOKU');
  return { url: d?.response?.payment?.url, token: d?.response?.payment?.token_id };
}
// DOKU signs notifications with OUR notification path as Request-Target
export function dokuVerify({ headers, rawBody, keys, target }) {
  const h = k => headers.get(k);
  if (h('client-id') !== keys.clientId || !h('signature')) return false;
  const expect = dokuSignature({ clientId: keys.clientId, secretKey: keys.secretKey, requestId: h('request-id'), timestamp: h('request-timestamp'), target, body: rawBody });
  return safeEq(expect, h('signature'));
}
export const dokuStatus = b => (b?.transaction?.status === 'SUCCESS' ? 'paid' : b?.transaction?.status === 'FAILED' ? 'failed' : 'pending');

// ── Biteship (rates + booking) ────────────────────────────────────────────────────────────────────
const biteHdr = key => ({ 'content-type': 'application/json', authorization: key });
const loc = (p, x) => ({
  ...(x.area_id ? { [p + '_area_id']: x.area_id } : {}),
  ...(x.postal_code ? { [p + '_postal_code']: Number(x.postal_code) } : {}),
  ...(x.lat != null && x.lng != null ? { [p + '_latitude']: x.lat, [p + '_longitude']: x.lng } : {})
});
const biteItems = items => items.map(i => ({ name: i.label, value: i.price, weight: Math.max(i.weight_g, 1), quantity: i.qty }));

export async function biteshipRates({ key, couriers, origin, destination, items, fetch: f = fetch }) {
  const r = await f('https://api.biteship.com/v1/rates/couriers', {
    method: 'POST', headers: biteHdr(key),
    body: JSON.stringify({ ...loc('origin', origin), ...loc('destination', destination), couriers: couriers || 'jne,sicepat,jnt,anteraja,gojek,grab', items: biteItems(items) })
  });
  const d = await json(r, 'Biteship rates');
  return (d.pricing || []).map(p => ({
    id: `biteship:${p.courier_code}:${p.courier_service_code}`, provider: 'biteship',
    courier: p.courier_code, service: p.courier_service_code,
    label: `${p.courier_name} ${p.courier_service_name}`.trim(), fee: Math.round(p.price), eta: p.duration || ''
  }));
}
export async function biteshipBook({ key, order, warehouse, fetch: f = fetch }) {
  const body = {
    reference_id: order.no,
    origin_contact_name: warehouse.contact?.name || warehouse.name, origin_contact_phone: warehouse.contact?.phone || '',
    origin_address: warehouse.address || '', ...loc('origin', warehouse),
    destination_contact_name: order.customer.name, destination_contact_phone: order.customer.phone,
    destination_address: order.destination.address || '', destination_note: order.destination.note || '', ...loc('destination', order.destination),
    courier_company: order.shipping.courier, courier_type: order.shipping.service, delivery_type: 'now',
    items: biteItems(order.items)
  };
  const d = await json(await f('https://api.biteship.com/v1/orders', { method: 'POST', headers: biteHdr(key), body: JSON.stringify(body) }), 'Biteship booking');
  return { id: d.id, waybill: d.courier?.waybill_id || null, tracking_id: d.courier?.tracking_id || null, status: d.status };
}
