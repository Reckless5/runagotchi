-- =====================================================================
-- Runagotchi: challenges
-- Run this AFTER schema.sql: Supabase → SQL Editor → New query → paste → Run.
-- =====================================================================

-- A challenge: run distance_km between starts_at and ends_at.
create table public.challenges (
  id          uuid primary key default gen_random_uuid(),
  creator     uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  distance_km numeric(6,1) not null check (distance_km > 0 and distance_km <= 1000),
  starts_at   timestamptz not null default now(),
  ends_at     timestamptz not null,
  created_at  timestamptz not null default now(),
  check (ends_at > starts_at and ends_at <= starts_at + interval '93 days')
);

-- Who is in it. Friends are "invited" until they join or decline.
create table public.challenge_members (
  challenge_id uuid not null references public.challenges(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  status       text not null default 'invited' check (status in ('invited', 'joined', 'declined')),
  created_at   timestamptz not null default now(),
  primary key (challenge_id, user_id)
);

-- Kudos (for the leaders) and encouragement (for the ones behind).
create table public.challenge_cheers (
  id           uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references public.challenges(id) on delete cascade,
  from_user    uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  to_user      uuid not null references public.profiles(id) on delete cascade,
  kind         text not null check (kind in ('kudos', 'encourage')),
  created_at   timestamptz not null default now(),
  unique (challenge_id, from_user, to_user, kind),
  check (from_user <> to_user)
);

-- ---------- Helpers (security definer so policies don't loop) ----------

create or replace function public.challenge_status(cid uuid, uid uuid)
returns text language sql stable security definer set search_path = public as $$
  select status from public.challenge_members where challenge_id = cid and user_id = uid;
$$;

create or replace function public.is_challenge_creator(cid uuid, uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.challenges where id = cid and creator = uid);
$$;

-- Each participant's total km inside the challenge window, for every challenge
-- the caller is part of. Only totals leave the database, never individual runs.
create or replace function public.challenge_progress_all()
returns table (challenge_id uuid, user_id uuid, km numeric)
language sql stable security definer set search_path = public as $$
  select m.challenge_id, m.user_id, coalesce(sum(r.km), 0)
  from public.challenge_members m
  join public.challenges c on c.id = m.challenge_id
  left join public.runs r
    on r.user_id = m.user_id
   and r.started_at >= c.starts_at
   and r.started_at <  c.ends_at
   and r.started_at <= now()
  where m.status = 'joined'
    and exists (select 1 from public.challenge_members me
                where me.challenge_id = m.challenge_id and me.user_id = auth.uid())
  group by m.challenge_id, m.user_id;
$$;
revoke execute on function public.challenge_progress_all() from public, anon;
grant execute on function public.challenge_progress_all() to authenticated;

-- ---------- Row level security ----------

alter table public.challenges        enable row level security;
alter table public.challenge_members enable row level security;
alter table public.challenge_cheers  enable row level security;

-- challenges: visible to its creator and members; anyone can start one; only the creator deletes it.
create policy "challenges: members can read"
  on public.challenges for select to authenticated
  using (creator = (select auth.uid()) or public.challenge_status(id, (select auth.uid())) is not null);
create policy "challenges: create own"
  on public.challenges for insert to authenticated
  with check (creator = (select auth.uid()) and starts_at >= now() - interval '5 minutes');
create policy "challenges: creator deletes"
  on public.challenges for delete to authenticated
  using (creator = (select auth.uid()));

-- members: visible inside the challenge. The creator adds themself (joined)
-- and invites accepted friends. Everyone answers only their own invite.
create policy "members: read within challenge"
  on public.challenge_members for select to authenticated
  using (public.challenge_status(challenge_id, (select auth.uid())) is not null
         or public.is_challenge_creator(challenge_id, (select auth.uid())));
create policy "members: creator adds"
  on public.challenge_members for insert to authenticated
  with check (
    public.is_challenge_creator(challenge_id, (select auth.uid()))
    and ((user_id = (select auth.uid()) and status = 'joined')
         or (status = 'invited' and public.are_friends((select auth.uid()), user_id)))
  );
create policy "members: answer own invite or leave"
  on public.challenge_members for update to authenticated
  using (user_id = (select auth.uid()) and status in ('invited', 'joined'))
  with check (user_id = (select auth.uid()) and status in ('joined', 'declined'));
revoke update on public.challenge_members from authenticated, anon;
grant update (status) on public.challenge_members to authenticated;

-- cheers: participants see them; joined members cheer other joined members; you can take yours back.
create policy "cheers: read within challenge"
  on public.challenge_cheers for select to authenticated
  using (public.challenge_status(challenge_id, (select auth.uid())) is not null);
create policy "cheers: give"
  on public.challenge_cheers for insert to authenticated
  with check (
    from_user = (select auth.uid())
    and public.challenge_status(challenge_id, (select auth.uid())) = 'joined'
    and public.challenge_status(challenge_id, to_user) = 'joined'
  );
create policy "cheers: take back own"
  on public.challenge_cheers for delete to authenticated
  using (from_user = (select auth.uid()));
