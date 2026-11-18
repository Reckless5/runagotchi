-- =====================================================================
-- Runagotchi: invite-only sign-up
-- Run this AFTER the earlier files: Supabase → SQL Editor → New query → paste → Run.
--
-- New accounts can only be created with an unused invite code
-- (the app sends it from links like https://runagotchi.netlify.app/?invite=CODE).
-- Existing accounts are not affected.
--
-- Make your own account an admin, so it can create invite links in the app:
--   update public.profiles set is_admin = true where username = 'YOUR_USERNAME';
--
-- Create an invite link without the app (prints the code):
--   insert into public.invites default values returning code;
--
-- Turn invite-only off again (anyone can sign up):
--   drop trigger if exists require_invite on auth.users;
-- =====================================================================

-- Only you (in the SQL Editor) can make admins; users can't change this
-- (007_debug.sql already limits which profile columns users may update).
alter table public.profiles add column if not exists is_admin boolean not null default false;

create table if not exists public.invites (
  code        text primary key default left(replace(gen_random_uuid()::text, '-', ''), 16),
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  used_by     uuid,            -- the new account's id (no foreign key: set while the account is being created)
  used_at     timestamptz
);
alter table public.invites enable row level security;

-- Admins see and remove their own invites. Creating goes through create_invite().
drop policy if exists "invites: admins read own" on public.invites;
create policy "invites: admins read own" on public.invites for select to authenticated
  using (created_by = auth.uid() and coalesce((select is_admin from public.profiles where id = auth.uid()), false));
drop policy if exists "invites: admins delete own unused" on public.invites;
create policy "invites: admins delete own unused" on public.invites for delete to authenticated
  using (created_by = auth.uid() and used_at is null and coalesce((select is_admin from public.profiles where id = auth.uid()), false));
revoke insert, update on public.invites from anon, authenticated;

create or replace function public.create_invite()
returns text language plpgsql security definer set search_path = public as $$
declare c text;
begin
  if auth.uid() is null or not coalesce((select is_admin from profiles where id = auth.uid()), false) then
    raise exception 'only admins can create invites';
  end if;
  insert into invites (created_by) values (auth.uid()) returning code into c;
  return c;
end $$;
revoke execute on function public.create_invite() from public, anon;
grant execute on function public.create_invite() to authenticated;

-- Lets the sign-up screen say right away whether a link still works.
create or replace function public.invite_ok(p_code text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from invites where code = p_code and used_at is null);
$$;
revoke execute on function public.invite_ok(text) from public;
grant execute on function public.invite_ok(text) to anon, authenticated;

-- The gate: every new account must bring an unused code (sent by the app as sign-up data "invite").
-- The code is used up in the same step, so one link makes exactly one account.
create or replace function public.require_invite()
returns trigger language plpgsql security definer set search_path = public as $$
declare c text := nullif(trim(coalesce(new.raw_user_meta_data ->> 'invite', '')), '');
begin
  if c is null then
    raise exception 'invite_required' using errcode = 'P0001';
  end if;
  update invites set used_by = new.id, used_at = now() where code = c and used_at is null;
  if not found then
    raise exception 'invite_invalid' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists require_invite on auth.users;
create trigger require_invite before insert on auth.users
  for each row execute function public.require_invite();
