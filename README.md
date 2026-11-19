# Sarang Order – multi-tenant ordering platform (backend + storefront + back office)

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
| **Themes** | Each store picks a theme (built in: **Market**, the default, and **Classic**), changes its colours, pictures and words with a live preview, or uploads its own theme .zip. Stores can share themes in a theme store the platform admin approves. Themes are HTML templates + CSS, no scripts. See [THEMES.md](THEMES.md). |
| **Quick view** | Every product card in every theme has quick view: photo, options, quantity and add, without leaving the page. |
| **Per-store keys** | Midtrans, DOKU, Biteship, Turnstile. AES-256-GCM encrypted with `MASTER_KEY`; shown masked; owner-only. |
| **Payments** | Midtrans Snap, DOKU Checkout, manual transfer (staff confirms). Webhooks verified by signature + amount, safe to repeat. |
| **Turnstile** | Per store on checkout; platform key on sign-up. Off until a store adds keys. |
| **Shipping** | Pickup (nearest or chosen store), store courier zones (by km from the warehouse), Biteship live rates + booking + tracking webhook. Chosen option is re-quoted on the server at checkout. |
| **Multi-warehouse** | Stock per warehouse. Each order ships from the nearest warehouse that has the whole order. Stock is reserved at checkout, committed when paid, released when unpaid orders expire (every 5 min). Late payments re-reserve or get flagged for refund. |
| **Staff** | Owner + staff roles. Staff manage products, stock, orders; only owners touch keys, theme, warehouses. |

| **Discounts** | Volume tiers (regular / business), coupon codes (percent or amount, minimum, max uses, expiry). Tier first, coupon on the remainder; the server recalculates both at checkout. |
| **Business accounts** | Owner creates a login per business customer; they get business pricing in the shop. |
| **Reviews & problem reports** | Customers rate delivered items and report a problem with photos inside a time window; staff resolve or reject. |

## Not in this phase (next)
- **Android app**: see `mobile/README.md` (Capacitor wrapper, config only; needs a machine with the Android SDK to build).
- Split shipments (one order from two warehouses) — today the whole order must fit one warehouse.
- Image uploads to the `media` bucket (theme/product images take https URLs for now).
- Rate limiting is per server instance; Turnstile is the main bot guard.

## Setup (≈20 minutes, once)
1. **Supabase** → new project → SQL Editor → run `0001_multitenant.sql`, `0002_discounts_feedback.sql`, then `0003_themes.sql` (all safe to run twice). Copy Project URL + secret key.
2. **GitHub** → push this folder to a new repo.
3. **Netlify** → import the repo → set the variables in `.env.example` → deploy.
   Point `*.yourdomain` (wildcard DNS) at Netlify so every store gets `<slug>.yourdomain`.
4. Create your super-admin once: `POST /api/super/setup` with `{ key: SUPER_SETUP_KEY, email, password }`.
5. Each store owner signs up, then pastes their own keys in the back office. They copy the webhook URLs shown by
   `GET /api/admin/secrets` into their Midtrans / DOKU / Biteship dashboards.

> ⚠️ Keep `MASTER_KEY` safe and never change it: every store's saved keys are encrypted with it.
> Test Midtrans and DOKU in **sandbox** first (`production: false`) — the request formats follow their docs but haven't been run against the live gateways yet.

## API (all JSON; store routes need `X-Tenant` or a store domain)
**Customer:** `GET /api/store` · `GET /api/themes/:ref/package` · `GET /api/menu` · `POST /api/quote` · `POST /api/checkout` · `GET /api/order?no=&phone=` · `GET /api/reviews` · `POST /api/review` · `POST /api/complaint` · `POST /api/b2b/login`
**Account:** `POST /api/signup` · `POST /api/login` · `POST /api/logout` · `GET /api/me` (Bearer token or cookie)
**Back office:** `/api/admin/store|theme|settings|secrets/:provider|staff|warehouses|products|variants|zones|stock|orders`,
`/api/admin/coupons|b2b|complaints|reviews|themes`, `POST /api/admin/themes` (upload .zip), `POST /api/admin/themes/:ref/use|submit|withdraw`, `POST /api/admin/orders/:no/confirm-payment`, `POST /api/admin/orders/:no/book`
**Super-admin:** `POST /api/super/setup` · `GET /api/super/themes` · `POST /api/super/themes/:id/approve|reject` · `GET /api/super/tenants` · `POST /api/super/tenants/:id/approve|suspend|domain`
**Webhooks:** `/api/webhook/midtrans/:slug` · `/api/webhook/doku/:slug` · `/api/webhook/biteship/:slug/:token`

## Run locally
```
npm test      # 23 automated checks: isolation, signatures, stock, routing, expiry, discounts, feedback, themes (no accounts needed)
npm run dev   # http://localhost:8888 with an in-memory database (super setup key: dev-setup-key-123456)
```

Demo logins (type store address `sarang` in the first box; leave it empty for the platform admin): owner@sarang.test / demo-password-1 · platform admin admin@demo.test / demo-admin-pass · business cafe.biru / demo-password-1 · coupon WELCOME10.
