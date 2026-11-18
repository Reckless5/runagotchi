# Runagotchi

A Tamagotchi-style pet that lives on the kilometers you run.

- Create and name your own pet
- Log runs by hand
- Friends: add each other by username and see each other's pets
- Challenges: challenge friends to a distance within a time limit (1 day to 1 month), see everyone's % of completion, give kudos to the leaders and encouragement to the ones behind
- Running together: tag friends on a run (or add them later); everyone who ran together this week gets a 🤝, runs side by side in the Run tab, and tagged friends can log the same run with one tap
- Sick / injured: a simple toggle; the pet looks sick or injured, hunger pauses, and in the Run tab it rides in a cart pulled by healthy friends
- Chat bubbles: say something to your pack; your latest message shows above your pet in the Run tab (a new one replaces the old)
- Run together: your pet and your friends' pets run as a pack through a moving landscape; the strongest lead, the weakest trail behind
- Each km = 10 food; food drains over time. No running → hungry → starving → fainted → starved
- A run of 5 km or more revives a starved pet

## How it's built
- Static site, no build step: `index.html` + `js/app.js`. Deploy the folder to any static host (Netlify, Vercel, Cloudflare Pages).
- Accounts, saving and friends use [Supabase](https://supabase.com). Connection details are in `js/config.js` (publishable key only, never the secret key). Leave them empty to run without accounts.
- Database tables and security rules: `supabase/schema.sql` and `supabase/002_challenges.sql`. Runs are private to their owner; friends only see each other's pet (name, look, hunger, level), never individual runs. Challenges only share each member's total km inside the challenge window.

## Supabase setup (once)
1. **SQL Editor → New query**: paste `supabase/schema.sql` and click **Run**. Then do the same with `supabase/002_challenges.sql` `supabase/003_watches.sql`, `supabase/004_coros_mcp.sql`, `supabase/005_run_buddies.sql`, `supabase/006_pack_name.sql`, `supabase/007_debug.sql`, `supabase/008_pack_chat.sql`, `supabase/009_condition.sql` and `supabase/010_invites.sql` (invite-only sign-up: see the comments at the top of that file for making yourself an admin).
2. **Authentication → URL Configuration**: set **Site URL** to your app's address (e.g. `https://runagotchi.netlify.app`) and add the same address under **Redirect URLs**.
3. Optional while testing: **Authentication → Sign In / Providers → Email** → turn off **Confirm email**, so sign-ups don't need the confirmation mail. Supabase's built-in mail server only sends a few emails per hour.

## Test accounts

Mark an account as a test account in the Supabase SQL Editor:

```sql
update public.profiles set is_debug = true where username = 'testrunner';
```

Test accounts get a 🐞 Debug card (set the health of their own pet and of test friends' pets) and the time machine in Settings. Users can't make themselves test accounts.

## Roadmap
- [x] Accounts and cloud saving (Supabase)
- [x] Friends: see your friends' pets
- [x] Privacy policy (`privacy.html`), fonts and libraries self-hosted (no third-party requests)
- [ ] COROS sync via COROS's self-service connection (OAuth + MCP), checked every 30 minutes and when the app opens. Built and tested against a fake COROS server; first test with the real COROS pending.
- [ ] Garmin and Suunto sync: backend and app ready, waiting for each brand's developer approval. See `docs/watch-applications.md` and `docs/watch-setup.md`.
