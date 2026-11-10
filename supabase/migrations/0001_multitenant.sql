-- Sarang Order (multi-tenant) – database setup for Supabase.
-- Run once: Supabase dashboard → SQL Editor → paste this whole file → Run.
--
-- SECURITY MODEL (same as sarang): only the server talks to the database, using the SECRET key.
-- Row Level Security is ON with NO policies, so the public anon/publishable key can read and write nothing.
-- Every business table carries tenant_id; the server always filters by the tenant it resolved from the request.

create extension if not exists pgcrypto;

-- ── Tenants ────────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.tenants (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$'),
  name       text not null,
  status     text not null default 'pending' check (status in ('pending','active','suspended')),
  theme      jsonb not null default '{}'::jsonb,   -- colours, font, logo, layout (validated by the server)
  settings   jsonb not null default '{}'::jsonb,   -- public shop settings: pickup, payment methods, turnstile site key …
  created_at timestamptz not null default now()
);

-- custom domains (subdomains of the platform domain are resolved from the slug and need no row here)
create table if not exists public.tenant_domains (
  host       text primary key,
  tenant_id  uuid not null references public.tenants(id) on delete cascade
);

-- staff/owner accounts; tenant_id NULL = platform super-admin
create table if not exists public.users (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid references public.tenants(id) on delete cascade,
  email      text not null,
  name       text,
  role       text not null check (role in ('super','owner','staff')),
  cred       jsonb not null,                       -- { salt, hash }  PBKDF2-SHA256, 210k rounds
  created_at timestamptz not null default now()
);
create unique index if not exists users_tenant_email on public.users (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(email));

-- per-tenant API keys (Midtrans, Doku, Biteship, Turnstile). Encrypted by the server (AES-256-GCM, MASTER_KEY);
-- the database never sees a key in plain text.
create table if not exists public.tenant_secrets (
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  provider   text not null check (provider in ('midtrans','doku','biteship','turnstile')),
  enc        text not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, provider)
);

-- ── Catalogue & warehouses ─────────────────────────────────────────────────────────────────────────
create table if not exists public.warehouses (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  name        text not null,
  address     text,
  postal_code text,
  area_id     text,                                -- Biteship area id (optional)
  lat         double precision,
  lng         double precision,
  contact     jsonb not null default '{}'::jsonb,  -- { name, phone } for courier pickup
  priority    int  not null default 0,             -- tie-breaker when two warehouses are equally close
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create index if not exists warehouses_tenant on public.warehouses (tenant_id);

create table if not exists public.products (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  name        text not null,
  description text,
  image       text,
  category    text,
  sort        int not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create index if not exists products_tenant on public.products (tenant_id);

create table if not exists public.variants (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  product_id  uuid not null references public.products(id) on delete cascade,
  name        text not null,
  sku         text,
  price       bigint not null check (price >= 0),  -- whole currency units
  weight_g    int not null default 0 check (weight_g >= 0),
  active      boolean not null default true
);
create index if not exists variants_tenant on public.variants (tenant_id);

-- stock per warehouse; "reserved" is held by unpaid orders until they are paid or expire
create table if not exists public.stock (
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  warehouse_id uuid not null references public.warehouses(id) on delete cascade,
  variant_id   uuid not null references public.variants(id) on delete cascade,
  qty          int not null default 0 check (qty >= 0),
  reserved     int not null default 0 check (reserved >= 0 and reserved <= qty),
  primary key (warehouse_id, variant_id)
);
create index if not exists stock_tenant on public.stock (tenant_id);

-- the store's own couriers: delivery zones by distance from a warehouse (warehouse_id NULL = all warehouses)
create table if not exists public.courier_zones (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  warehouse_id uuid references public.warehouses(id) on delete cascade,
  name         text not null,
  max_km       numeric not null check (max_km > 0),
  fee          bigint not null check (fee >= 0),
  eta          text
);
create index if not exists courier_zones_tenant on public.courier_zones (tenant_id);

-- ── Orders ─────────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.orders (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  no           text not null,
  status       text not null check (status in ('pending_payment','paid','preparing','shipped','delivered','cancelled','expired')),
  customer     jsonb not null,                     -- { name, phone, email }
  destination  jsonb not null,                     -- { address, postal_code, area_id, lat, lng, note }
  items        jsonb not null,                     -- price snapshot taken by the server
  warehouse_id uuid references public.warehouses(id),
  shipping     jsonb not null,                     -- { id, provider, courier, service, label, fee, booking }
  payment      jsonb not null,                     -- { provider, status, ref, url }
  subtotal     bigint not null,
  shipping_fee bigint not null,
  total        bigint not null,
  expires_at   timestamptz,
  created_at   timestamptz not null default now(),
  unique (tenant_id, no)
);
create index if not exists orders_tenant_created on public.orders (tenant_id, created_at desc);
create index if not exists orders_pending on public.orders (status, expires_at) where status = 'pending_payment';

create table if not exists public.payment_events (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  order_no   text,
  provider   text not null,
  status     text,
  raw        jsonb not null,
  created_at timestamptz not null default now()
);

-- ── Atomic stock operations (called by the server through /rest/v1/rpc/…) ──────────────────────────
-- p_items: [{ "variant_id": "...", "qty": 2 }, …]. Raises 'out_of_stock' and changes nothing if any line is short.
create or replace function public.reserve_stock(p_tenant uuid, p_warehouse uuid, p_items jsonb)
returns boolean language plpgsql as $$
declare it jsonb; n int;
begin
  for it in select * from jsonb_array_elements(p_items) loop
    update public.stock set reserved = reserved + (it->>'qty')::int
     where tenant_id = p_tenant and warehouse_id = p_warehouse and variant_id = (it->>'variant_id')::uuid
       and qty - reserved >= (it->>'qty')::int;
    get diagnostics n = row_count;
    if n = 0 then raise exception 'out_of_stock'; end if;
  end loop;
  return true;
end $$;

create or replace function public.release_stock(p_tenant uuid, p_warehouse uuid, p_items jsonb)
returns boolean language plpgsql as $$
declare it jsonb;
begin
  for it in select * from jsonb_array_elements(p_items) loop
    update public.stock set reserved = greatest(reserved - (it->>'qty')::int, 0)
     where tenant_id = p_tenant and warehouse_id = p_warehouse and variant_id = (it->>'variant_id')::uuid;
  end loop;
  return true;
end $$;

-- paid: the reserved units leave the warehouse for good
create or replace function public.commit_stock(p_tenant uuid, p_warehouse uuid, p_items jsonb)
returns boolean language plpgsql as $$
declare it jsonb;
begin
  for it in select * from jsonb_array_elements(p_items) loop
    update public.stock set qty = greatest(qty - (it->>'qty')::int, 0),
                            reserved = greatest(reserved - (it->>'qty')::int, 0)
     where tenant_id = p_tenant and warehouse_id = p_warehouse and variant_id = (it->>'variant_id')::uuid;
  end loop;
  return true;
end $$;

-- ── Lock everything to the server ──────────────────────────────────────────────────────────────────
do $$ declare t text; begin
  foreach t in array array['tenants','tenant_domains','users','tenant_secrets','warehouses','products','variants',
                           'stock','courier_zones','orders','payment_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
revoke execute on function public.reserve_stock(uuid, uuid, jsonb), public.release_stock(uuid, uuid, jsonb),
                           public.commit_stock(uuid, uuid, jsonb) from public, anon, authenticated;

-- private bucket for logos, banners and product photos (served through the server)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', false, 4718592, array['image/jpeg','image/png','image/webp','image/gif'])
on conflict (id) do update set public = false;
