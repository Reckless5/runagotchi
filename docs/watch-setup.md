# Setting up watch connections

## Once, now

1. **Database:** Supabase → SQL Editor → New query → paste `supabase/003_watches.sql` → Run. Then the same with `supabase/004_coros_mcp.sql`.
2. **Server function:** Supabase → **Edge Functions** → **Deploy a new function** → **Via editor**.
   - Name: `watches` (exactly this)
   - Replace the example code with the whole of `supabase/functions/watches/index.ts` → **Deploy**.
   - Open the function's **Details / Settings** and turn **Verify JWT** (or "Enforce JWT verification") **off**, then save. The watch brands can't send a Runagotchi login, so the function checks logins itself.
3. **Secrets:** Supabase → Edge Functions → **Secrets** → add:
   - `APP_URL` = `https://runagotchi.netlify.app`
   - `WEBHOOK_KEY` = a long random string (keep it secret; it goes into the webhook URLs)

4. **COROS schedule:** open `supabase/coros_schedule.sql`, replace `YOUR_WEBHOOK_KEY` with your key, and run it in the SQL Editor. This checks COROS for new runs every 30 minutes.

After this, the app shows "Your watches": **COROS can be connected right away** (it uses COROS's self-service connection, no approval needed). Garmin and Suunto show "Coming soon".

### COROS: if runs don't show up

COROS's self-service connection is a standard "MCP" connection, and the function finds COROS's activity list by itself. If runs are missing after connecting: in the app, tap **Check connection** under COROS, then **Copy**, and send the text to Claude. It shows which COROS function was used and what came back, so the import can be adjusted.

To update the function after a code change: Edge Functions → watches → **Code** → paste the new `index.ts` → Deploy.

## When a brand approves you

Add that brand's secrets (Edge Functions → Secrets). As soon as they are set, its **Connect** button appears in the app.

| Brand | Secrets |
|---|---|
| Garmin | `GARMIN_CLIENT_ID`, `GARMIN_CLIENT_SECRET` |
| Suunto | `SUUNTO_CLIENT_ID`, `SUUNTO_CLIENT_SECRET`, `SUUNTO_SUBSCRIPTION_KEY`, optional `SUUNTO_WEBHOOK_SECRET` |

In the brand's developer portal, enter the redirect URL and webhook URL from `watch-applications.md`.
For Garmin, enable push for **Activities** (activity summaries) and **Deregistrations**.

Then the code needs a last check against the brand's real documentation (places marked `CHECK` in `index.ts`). Send the docs to Claude for this.

COROS Partner API (optional, later): would add instant push instead of checking every 30 minutes.

## Running the server tests

```
cd supabase/functions/watches
RUNAGOTCHI_TEST=1 WEBHOOK_KEY=k SUPABASE_URL=http://fn.test SUPABASE_SERVICE_ROLE_KEY=x COROS_MCP_URL=http://localhost:8799/mcp \
  deno test --allow-env --allow-net watches_test.ts coros_flow_test.ts
```
