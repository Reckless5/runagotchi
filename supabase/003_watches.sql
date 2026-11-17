-- =====================================================================
-- Runagotchi: running watch connections (Garmin, COROS, Suunto)
-- Run this AFTER 002_challenges.sql: Supabase → SQL Editor → New query → paste → Run.
-- =====================================================================

-- ---------- Runs: remember where an imported run came from ----------

alter table public.runs drop constraint if exists runs_source_check;
alter table public.runs add constraint runs_source_check
  check (source in ('manual', 'coros', 'garmin', 'suunto'));

-- The watch brand's own id for the activity, so a run is never imported twice.
alter table public.runs add column if not exists external_id text;
-- (Manual runs have no external_id; empty values never clash with each other.)
alter table public.runs drop constraint if exists runs_external_key;
alter table public.runs add constraint runs_external_key unique (user_id, source, external_id);

-- ---------- Login tokens for the watch brands (server only) ----------
-- Row level security is on with NO policies, and all permissions are revoked,
-- so the app can never read or write these. Only the server function, which
-- uses the service role key, can.

create table if not exists public.watch_tokens (
  user_id          uuid not null references public.profiles(id) on delete cascade,
  provider         text not null check (provider in ('garmin', 'coros', 'suunto')),
  provider_user_id text not null,
  access_token     text not null,
  refresh_token    text,
  expires_at       timestamptz,
  updated_at       timestamptz not null default now(),
  primary key (user_id, provider)
);
-- A watch account can only be linked to one Runagotchi account.
create unique index if not exists watch_tokens_provider_user_idx
  on public.watch_tokens (provider, provider_user_id);

-- Short-lived state for the "Connect" login round trip (with PKCE verifier).
create table if not exists public.oauth_states (
  state         text primary key,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  provider      text not null,
  code_verifier text not null,
  created_at    timestamptz not null default now()
);

alter table public.watch_tokens enable row level security;
alter table public.oauth_states enable row level security;
revoke all on public.watch_tokens, public.oauth_states from anon, authenticated;

-- ---------- Public: which watches a user has connected ----------
-- No tokens here: just enough for the Settings screen.

create table if not exists public.watch_links (
  user_id      uuid not null references public.profiles(id) on delete cascade,
  provider     text not null check (provider in ('garmin', 'coros', 'suunto')),
  connected_at timestamptz not null default now(),
  last_sync_at timestamptz,
  primary key (user_id, provider)
);
alter table public.watch_links enable row level security;

create policy "watch_links: read own"
  on public.watch_links for select to authenticated using (user_id = (select auth.uid()));
-- Creating, updating and removing links is done by the server function only.
revoke insert, update, delete on public.watch_links from anon, authenticated;
