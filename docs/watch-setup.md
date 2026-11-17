# Setting up watch connections

## Once, now

1. **Database:** Supabase → SQL Editor → New query → paste `supabase/003_watches.sql` → Run.
2. **Server function:** Supabase → **Edge Functions** → **Deploy a new function** → **Via editor**.
   - Name: `watches` (exactly this)
   - Replace the example code with the whole of `supabase/functions/watches/index.ts` → **Deploy**.
   - Open the function's **Details / Settings** and turn **Verify JWT** (or "Enforce JWT verification") **off**, then save. The watch brands can't send a Runagotchi login, so the function checks logins itself.
3. **Secrets:** Supabase → Edge Functions → **Secrets** → add:
   - `APP_URL` = `https://runagotchi.netlify.app`
   - `WEBHOOK_KEY` = a long random string (keep it secret; it goes into the webhook URLs)

After this, the app shows "Your watches" with all three brands as "Coming soon".

## When a brand approves you

Add that brand's secrets (Edge Functions → Secrets). As soon as they are set, its **Connect** button appears in the app.

| Brand | Secrets |
|---|---|
| Garmin | `GARMIN_CLIENT_ID`, `GARMIN_CLIENT_SECRET` |
| Suunto | `SUUNTO_CLIENT_ID`, `SUUNTO_CLIENT_SECRET`, `SUUNTO_SUBSCRIPTION_KEY`, optional `SUUNTO_WEBHOOK_SECRET` |
| COROS | `COROS_CLIENT_ID`, `COROS_CLIENT_SECRET`, `COROS_AUTHORIZE_URL`, `COROS_TOKEN_URL` (from COROS's docs) |

In the brand's developer portal, enter the redirect URL and webhook URL from `watch-applications.md`.
For Garmin, enable push for **Activities** (activity summaries) and **Deregistrations**.

Then the code needs a last check against the brand's real documentation (places marked `CHECK` in `index.ts`), and COROS needs its webhook format added. Send the docs to Claude for this.

## Running the server tests

```
cd supabase/functions/watches
RUNAGOTCHI_TEST=1 WEBHOOK_KEY=test SUPABASE_URL=http://localhost SUPABASE_SERVICE_ROLE_KEY=x deno test --allow-env --allow-net watches_test.ts
```
