-- =====================================================================
-- Runagotchi: running together
-- Run this AFTER the earlier files: Supabase → SQL Editor → New query → paste → Run.
-- =====================================================================

-- "I ran with these friends": the owner of a run tags accepted friends.
-- Time and distance are copied from the run, so friends can log the same run.
create table if not exists public.run_companions (
  run_id     uuid not null references public.runs(id) on delete cascade,
  owner_id   uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  friend_id  uuid not null references public.profiles(id) on delete cascade,
  started_at timestamptz not null default now(),
  km         numeric(6,2),
  created_at timestamptz not null default now(),
  primary key (run_id, friend_id),
  check (owner_id <> friend_id)
);
create index if not exists run_companions_time_idx on public.run_companions (started_at);

-- Always take time and distance from the run itself.
create or replace function public.run_companions_fill()
returns trigger language plpgsql as $$
begin
  select r.started_at, r.km into new.started_at, new.km from public.runs r where r.id = new.run_id;
  return new;
end $$;
drop trigger if exists run_companions_fill on public.run_companions;
create trigger run_companions_fill before insert on public.run_companions
  for each row execute function public.run_companions_fill();

alter table public.run_companions enable row level security;

-- Seen by the runner, the tagged friend, and people who are friends with both
-- (so they can see that two of their friends ran together).
create policy "run_companions: participants and mutual friends"
  on public.run_companions for select to authenticated
  using (
    (select auth.uid()) in (owner_id, friend_id)
    or (public.are_friends((select auth.uid()), owner_id) and public.are_friends((select auth.uid()), friend_id))
  );
-- Only on your own runs, and only accepted friends.
create policy "run_companions: tag friends on own runs"
  on public.run_companions for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and exists (select 1 from public.runs r where r.id = run_id and r.user_id = (select auth.uid()))
    and public.are_friends((select auth.uid()), friend_id)
  );
-- The runner can untag; a tagged friend can remove themselves.
create policy "run_companions: owner or tagged friend removes"
  on public.run_companions for delete to authenticated
  using ((select auth.uid()) in (owner_id, friend_id));
revoke update on public.run_companions from anon, authenticated;
