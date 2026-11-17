-- =====================================================================
-- Runagotchi: check COROS for new runs every 30 minutes.
-- 1. Replace YOUR_WEBHOOK_KEY below with the WEBHOOK_KEY secret you set for the function.
-- 2. Supabase → SQL Editor → New query → paste → Run.
-- To stop it later:  select cron.unschedule('coros-sync');
-- =====================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'coros-sync',
  '*/30 * * * *',
  $$
  select net.http_post(
    url     := 'https://uqwuhdwhzuqudnvubwep.supabase.co/functions/v1/watches/cron?key=YOUR_WEBHOOK_KEY',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body    := '{}'::jsonb
  );
  $$
);
