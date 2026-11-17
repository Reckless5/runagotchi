-- =====================================================================
-- Runagotchi: debug / test accounts
-- Run this AFTER the earlier files: Supabase → SQL Editor → New query → paste → Run.
--
-- To make an account a test account afterwards, run (with its username):
--   update public.profiles set is_debug = true where username = 'testrunner';
-- To switch it off again:
--   update public.profiles set is_debug = false where username = 'testrunner';
-- =====================================================================

-- Only you (in the SQL Editor) can mark test accounts; users can't change this.
alter table public.profiles add column if not exists is_debug boolean not null default false;
revoke update on public.profiles from anon, authenticated;
grant update (username, pack_name) on public.profiles to authenticated;

-- A health override: "at debug_at the pet had debug_food food". Hunger carries on
-- from there as usual, and runs after that moment still feed the pet.
alter table public.pets add column if not exists debug_food real check (debug_food is null or (debug_food >= 0 and debug_food <= 100));
alter table public.pets add column if not exists debug_at timestamptz;

-- The override can only be changed through debug_set_pet() below.
create or replace function public.pets_debug_guard()
returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('runagotchi.debug_ok', true), '') <> 'on' then
    if tg_op = 'INSERT' then
      new.debug_food := null; new.debug_at := null;
    else
      new.debug_food := old.debug_food; new.debug_at := old.debug_at;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists pets_debug_guard on public.pets;
create trigger pets_debug_guard before insert or update on public.pets
  for each row execute function public.pets_debug_guard();

-- Set a pet's health. Allowed for test accounts: on their own pet, and on pets of
-- friends who are test accounts too. p_food = null clears the override.
-- p_hours_ago lets you set "this was the state N hours ago" (e.g. 0 food 73 h ago = starved).
create or replace function public.debug_set_pet(p_target uuid, p_food real, p_hours_ago real default 0)
returns void language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  at timestamptz := now() - make_interval(secs => greatest(coalesce(p_hours_ago, 0), 0) * 3600);
begin
  if me is null or not coalesce((select is_debug from profiles where id = me), false) then
    raise exception 'not a test account';
  end if;
  if p_target <> me and not (coalesce((select is_debug from profiles where id = p_target), false) and public.are_friends(me, p_target)) then
    raise exception 'you can only change your own pet or pets of test friends';
  end if;
  perform set_config('runagotchi.debug_ok', 'on', true);
  if p_food is null then
    update pets set debug_food = null, debug_at = null where user_id = p_target;
  else
    -- Also update what friends see right away.
    update pets set debug_food = p_food, debug_at = at,
      food = p_food, snapshot_at = at, zero_at = case when p_food <= 0 then at end,
      dead = false, death_at = null, updated_at = now()
    where user_id = p_target;
  end if;
  perform set_config('runagotchi.debug_ok', 'off', true);
end $$;
revoke execute on function public.debug_set_pet(uuid, real, real) from public, anon;
grant execute on function public.debug_set_pet(uuid, real, real) to authenticated;
