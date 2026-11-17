-- =====================================================================
-- Runagotchi: COROS via its self-service MCP connection
-- Run this AFTER 003_watches.sql: Supabase → SQL Editor → New query → paste → Run.
-- =====================================================================

-- Runagotchi registers itself with COROS automatically the first time someone
-- taps "Connect COROS". The resulting app id is kept here (server only).
create table if not exists public.oauth_clients (
  provider      text primary key,
  client_id     text not null,
  client_secret text,
  auth_method   text not null default 'none',
  meta          jsonb not null default '{}',
  created_at    timestamptz not null default now()
);
alter table public.oauth_clients enable row level security;
revoke all on public.oauth_clients from anon, authenticated;
