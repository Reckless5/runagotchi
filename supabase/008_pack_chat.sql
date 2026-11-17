-- =====================================================================
-- Runagotchi: chat bubbles in the Run tab
-- Run this AFTER the earlier files: Supabase → SQL Editor → New query → paste → Run.
-- =====================================================================

-- One row per person: their latest message. A new message replaces the old one.
create table if not exists public.pack_messages (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  body       text not null check (char_length(btrim(body)) between 1 and 80),
  created_at timestamptz not null default now()
);
alter table public.pack_messages enable row level security;

-- You and your accepted friends see it.
create policy "pack_messages: own and friends'"
  on public.pack_messages for select to authenticated
  using (user_id = (select auth.uid()) or public.are_friends((select auth.uid()), user_id));
create policy "pack_messages: write own"
  on public.pack_messages for insert to authenticated with check (user_id = (select auth.uid()));
create policy "pack_messages: replace own"
  on public.pack_messages for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "pack_messages: delete own"
  on public.pack_messages for delete to authenticated using (user_id = (select auth.uid()));
