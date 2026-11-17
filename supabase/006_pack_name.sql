-- =====================================================================
-- Runagotchi: a name for your running group (the pack in the Run tab)
-- Supabase → SQL Editor → New query → paste → Run.
-- =====================================================================
alter table public.profiles add column if not exists pack_name text
  check (pack_name is null or char_length(pack_name) between 1 and 30);
