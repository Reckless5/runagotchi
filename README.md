# Runagotchi

A Tamagotchi-style pet that lives on the kilometers you run.

- Create and name your own pet
- Log runs by hand or import COROS exports (.fit, .tcx, .gpx)
- Each km = 10 food; food drains over time. No running → hungry → starving → fainted → starved
- A run of 5 km or more revives a starved pet

## How it's built
- Static site, no build step: `index.html` + `js/app.js`. Deploy the folder to any static host (Netlify, Vercel, Cloudflare Pages).
- Accounts, saving and friends use [Supabase](https://supabase.com). Connection details are in `js/config.js` (publishable key only, never the secret key). Leave them empty to run without accounts.
- Database tables and security rules: `supabase/schema.sql`. Runs are private to their owner; friends only see each other's pet (name, look, hunger, level), never individual runs.

## Supabase setup (once)
1. **SQL Editor → New query**: paste `supabase/schema.sql` and click **Run**.
2. **Authentication → URL Configuration**: set **Site URL** to your app's address (e.g. `https://runagotchi.netlify.app`) and add the same address under **Redirect URLs**.
3. Optional while testing: **Authentication → Sign In / Providers → Email** → turn off **Confirm email**, so sign-ups don't need the confirmation mail. Supabase's built-in mail server only sends a few emails per hour.

## Roadmap
- [x] Accounts and cloud saving (Supabase)
- [x] Friends: see your friends' pets
- [ ] Automatic COROS sync
- [ ] Garmin sync
