-- =====================================================================
-- Runagotchi database schema
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- Safe to run once on a fresh project.
-- =====================================================================

-- ---------- Tables ----------

-- One profile per account. The username is how friends find you.
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  username    text not null unique check (username ~ '^[a-z0-9_]{3,20}$'),
  created_at  timestamptz not null default now()
);

-- One pet per account. The "snapshot" columns are what friends see:
-- the owner's app recalculates them whenever runs change, and friends'
-- apps continue the hunger countdown from snapshot_at.
-- Friends never see individual runs.
create table public.pets (
  user_id     uuid primary key references public.profiles(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 16),
  shape       text not null,
  color       text not null,
  pattern     text not null,
  acc         text not null,
  difficulty  text not null check (difficulty in ('easy', 'normal', 'hard')),
  born_at     timestamptz not null,
  -- snapshot shared with friends
  food        real not null default 70,
  zero_at     timestamptz,
  dead        boolean not null default false,
  death_at    timestamptz,
  level       int not null default 1,
  stage       text not null default 'baby',
  snapshot_at timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Runs are private: only the owner can read or change them.
create table public.runs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  started_at  timestamptz not null,
  km          numeric(6,2) not null check (km > 0 and km <= 400),
  dur_min     numeric(7,1) check (dur_min is null or dur_min > 0),
  source      text not null default 'manual' check (source in ('manual', 'coros', 'garmin')),
  created_at  timestamptz not null default now()
);
create index runs_user_idx on public.runs (user_id, started_at desc);

-- Friend requests. "pending" until the other person accepts.
create table public.friendships (
  id          uuid primary key default gen_random_uuid(),
  requester   uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  addressee   uuid not null references public.profiles(id) on delete cascade,
  status      text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at  timestamptz not null default now(),
  check (requester <> addressee)
);
-- Only one friendship row per pair, whichever direction it was sent.
create unique index friendships_pair_idx
  on public.friendships (least(requester, addressee), greatest(requester, addressee));

-- ---------- Helper ----------

create or replace function public.are_friends(a uuid, b uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and ((f.requester = a and f.addressee = b) or (f.requester = b and f.addressee = a))
  );
$$;

-- ---------- Row level security ----------

alter table public.profiles    enable row level security;
alter table public.pets        enable row level security;
alter table public.runs        enable row level security;
alter table public.friendships enable row level security;

-- profiles: any signed-in user can look up usernames; you only write your own.
create policy "profiles: signed-in users can read"
  on public.profiles for select to authenticated using (true);
create policy "profiles: create own"
  on public.profiles for insert to authenticated with check (id = (select auth.uid()));
create policy "profiles: update own"
  on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- pets: you see your own pet and your accepted friends' pets; you only write your own.
create policy "pets: read own and friends'"
  on public.pets for select to authenticated
  using (user_id = (select auth.uid()) or public.are_friends((select auth.uid()), user_id));
create policy "pets: create own"
  on public.pets for insert to authenticated with check (user_id = (select auth.uid()));
create policy "pets: update own"
  on public.pets for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "pets: delete own"
  on public.pets for delete to authenticated using (user_id = (select auth.uid()));

-- runs: owner only, for everything.
create policy "runs: owner only"
  on public.runs for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- friendships: both people see the row; only the requester creates it (as pending);
-- only the addressee can accept it; either side can delete it (decline / cancel / unfriend).
create policy "friendships: participants can read"
  on public.friendships for select to authenticated
  using ((select auth.uid()) in (requester, addressee));
create policy "friendships: send request"
  on public.friendships for insert to authenticated
  with check (requester = (select auth.uid()) and status = 'pending');
create policy "friendships: addressee accepts"
  on public.friendships for update to authenticated
  using (addressee = (select auth.uid()) and status = 'pending')
  with check (addressee = (select auth.uid()) and status = 'accepted');
create policy "friendships: either side removes"
  on public.friendships for delete to authenticated
  using ((select auth.uid()) in (requester, addressee));

-- Accepting may only change the status column, nothing else.
revoke update on public.friendships from authenticated, anon;
grant update (status) on public.friendships to authenticated;
