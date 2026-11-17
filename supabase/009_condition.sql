-- =====================================================================
-- Runagotchi: sick / injured
-- Run this AFTER the earlier files: Supabase → SQL Editor → New query → paste → Run.
-- =====================================================================

-- condition: null = healthy, 'sick' or 'injured'. While set, hunger is paused.
-- rest_periods: earlier sick/injured periods, [[from, to], ...] (ISO times),
-- so the pet's history can be replayed with those pauses.
alter table public.pets add column if not exists condition text check (condition is null or condition in ('sick', 'injured'));
alter table public.pets add column if not exists condition_since timestamptz;
alter table public.pets add column if not exists rest_periods jsonb not null default '[]'::jsonb;
