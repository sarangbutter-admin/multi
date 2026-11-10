# Sarang Order – multi-tenant ordering platform (backend, phase 1)

Many stores on one platform. Each store has its own theme, its own payment / shipping / Turnstile keys,
its own warehouses and stock. Built from the sarang site's approach (Netlify functions + Supabase, server holds every secret,
server recalculates every price), moved from a single `kv` table to proper tables with `tenant_id` on every row.

```
Customer app (one shared Android app / PWA) ─┐
Store back office ───────────────────────────┼─► Netlify  /api/*  (lib/app.mjs) ─► Supabase (Postgres)
Midtrans · DOKU · Biteship webhooks ─────────┘        │
                                                      └─► Midtrans / DOKU / Biteship / Turnstile with THAT store's keys
```

## What's in this phase
| Area | What it does |
|---|---|
| **Tenants** | Self sign-up → store is `pending` (owner can set it up) → you approve in super-admin → `active`. Suspend any time. |
| **Which store?** | `X-Tenant: <slug>` header (the shared app), `<slug>.PLATFORM_DOMAIN`, or a custom domain you add. |
| **Themes** | Colours, font (8 allowed), corner radius, light/dark, grid/list, logo, banner. Validated; defaults filled in. |
| **Per-store keys** | Midtrans, DOKU, Biteship, Turnstile. AES-256-GCM encrypted with `MASTER_KEY`; shown masked; owner-only. |
| **Payments** | Midtrans Snap, DOKU Checkout, manual transfer (staff confirms). Webhooks verified by signature + amount, safe to repeat. |
| **Turnstile** | Per store on checkout; platform key on sign-up. Off until a store adds keys. |
| **Shipping** | Pickup (nearest or chosen store), store courier zones (by km from the warehouse), Biteship live rates + booking + tracking webhook. Chosen option is re-quoted on the server at checkout. |
| **Multi-warehouse** | Stock per warehouse. Each order ships from the nearest warehouse that has the whole order. Stock is reserved at checkout, committed when paid, released when unpaid orders expire (every 5 min). Late payments re-reserve or get flagged for refund. |
| **Staff** | Owner + staff roles. Staff manage products, stock, orders; only owners touch keys, theme, warehouses. |

## Not in this phase (next)
- **The app screens** (customer storefront + store back office), driven by `/api/store` theme → phase 2, then wrap as Android with Capacitor.
- Coupons, reviews, complaints, B2B from sarang — port once the core is approved.
- Split shipments (one order from two warehouses) — today the whole order must fit one warehouse.
- Image uploads to the `media` bucket (theme/product images take https URLs for now).
- Rate limiting is per server instance; Turnstile is the main bot guard.

## Setup (≈20 minutes, once)
1. **Supabase** → new project → SQL Editor → run `supabase/migrations/0001_multitenant.sql`. Copy Project URL + secret key.
2. **GitHub** → push this folder to a new repo.
3. **Netlify** → import the repo → set the variables in `.env.example` → deploy.
   Point `*.yourdomain` (wildcard DNS) at Netlify so every store gets `<slug>.yourdomain`.
4. Create your super-admin once: `POST /api/super/setup` with `{ key: SUPER_SETUP_KEY, email, password }`.
5. Each store owner signs up, then pastes their own keys in the back office. They copy the webhook URLs shown by
   `GET /api/admin/secrets` into their Midtrans / DOKU / Biteship dashboards.

> ⚠️ Keep `MASTER_KEY` safe and never change it: every store's saved keys are encrypted with it.
> Test Midtrans and DOKU in **sandbox** first (`production: false`) — the request formats follow their docs but haven't been run against the live gateways yet.

## API (all JSON; store routes need `X-Tenant` or a store domain)
**Customer:** `GET /api/store` · `GET /api/menu` · `POST /api/quote` · `POST /api/checkout` · `GET /api/order?no=&phone=`
**Account:** `POST /api/signup` · `POST /api/login` · `POST /api/logout` · `GET /api/me` (Bearer token or cookie)
**Back office:** `/api/admin/store|theme|settings|secrets/:provider|staff|warehouses|products|variants|zones|stock|orders`,
`POST /api/admin/orders/:no/confirm-payment`, `POST /api/admin/orders/:no/book`
**Super-admin:** `POST /api/super/setup` · `GET /api/super/tenants` · `POST /api/super/tenants/:id/approve|suspend|domain`
**Webhooks:** `/api/webhook/midtrans/:slug` · `/api/webhook/doku/:slug` · `/api/webhook/biteship/:slug/:token`

## Run locally
```
npm test      # 12 automated checks: isolation, signatures, stock, routing, expiry (no accounts needed)
npm run dev   # http://localhost:8888 with an in-memory database (super setup key: dev-setup-key-123456)
```
