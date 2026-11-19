-- Coupons, volume/business discounts, reviews, complaints and business (B2B) accounts.
-- Run after 0001. Safe to run twice.

alter table public.orders
  add column if not exists tier_discount   bigint not null default 0,
  add column if not exists coupon_code     text,
  add column if not exists coupon_discount bigint not null default 0,
  add column if not exists b2b_id          uuid,
  add column if not exists delivered_at    timestamptz;

create table if not exists public.coupons (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  code         text not null check (code ~ '^[A-Z0-9]{1,16}$'),
  type         text not null check (type in ('pct','amt')),
  value        bigint not null check (value > 0),
  min_purchase bigint not null default 0 check (min_purchase >= 0),
  max_uses     int    not null default 0 check (max_uses >= 0),   -- 0 = unlimited
  used         int    not null default 0 check (used >= 0),
  expires_at   timestamptz,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (tenant_id, code)
);

create table if not exists public.b2b_accounts (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  name       text not null,
  phone      text,
  login      text not null check (login ~ '^[a-z0-9_.]{3,20}$'),
  cred       jsonb not null,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, login)
);

create table if not exists public.reviews (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  order_no     text not null,
  product_id   uuid not null references public.products(id) on delete cascade,
  product_name text not null,
  name         text not null,
  stars        int  not null check (stars between 1 and 5),
  text         text not null default '',
  created_at   timestamptz not null default now(),
  unique (tenant_id, order_no, product_id)
);
create index if not exists reviews_tenant_product on public.reviews (tenant_id, product_id);

create table if not exists public.complaints (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  order_no   text not null,
  name       text not null,
  phone      text not null,
  reason     text not null,
  item       text,
  text       text not null,
  nimg       int  not null default 0,
  status     text not null default 'open' check (status in ('open','resolved','rejected')),
  note       text not null default '',
  created_at timestamptz not null default now(),
  unique (tenant_id, order_no)
);

-- complaint photos are small JPEG/WebP data URLs (the server caps each at ~260 KB)
create table if not exists public.complaint_images (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  complaint_id uuid not null references public.complaints(id) on delete cascade,
  position     int  not null default 0,
  data         text not null
);
create index if not exists complaint_images_complaint on public.complaint_images (complaint_id);

do $$ declare t text; begin
  foreach t in array array['coupons','b2b_accounts','reviews','complaints','complaint_images'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
