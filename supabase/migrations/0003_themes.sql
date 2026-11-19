-- Theme packages: stores can pick a built-in theme, upload their own, or use one shared in the theme store.
-- Run after 0002. Safe to run twice.

alter table public.tenants add column if not exists theme_ref text not null default 'bold';  -- built-in name or themes.id

create table if not exists public.themes (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid references public.tenants(id) on delete cascade,  -- the store that uploaded it
  slug        text not null check (slug ~ '^[a-z0-9-]{1,40}$'),
  name        text not null,
  version     text not null default '1.0.0',
  manifest    jsonb not null,                 -- name, author, description, settings
  css         text not null default '',
  templates   jsonb not null,                 -- { layout, card }
  assets      jsonb not null default '{}',    -- { "hero.png": "data:image/png;base64,…" } (max 1.5 MB)
  preview     text,
  hash        text not null,
  status      text not null default 'private' check (status in ('private','review','public','rejected')),
  review_note text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, slug)
);
create index if not exists themes_status on public.themes (status);

alter table public.themes enable row level security;
revoke all on public.themes from anon, authenticated;
