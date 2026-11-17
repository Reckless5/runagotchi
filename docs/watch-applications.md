# Applying for watch access: Garmin, COROS, Suunto

Copy-paste texts for the three developer programs. Adjust anything that isn't true for you.

**Details used everywhere**

| | |
|---|---|
| App name | Runagotchi |
| Developer | Andreas Leutgeb (private, non-commercial project, Austria) |
| Contact | andeleutgeb@gmail.com |
| Website | https://runagotchi.netlify.app |
| Privacy policy | https://runagotchi.netlify.app/privacy.html |
| Source code | https://github.com/Reckless5/runagotchi (private, can be shared on request) |

**Redirect URLs** (where the brand sends users back after they log in):

```
https://uqwuhdwhzuqudnvubwep.supabase.co/functions/v1/watches/callback/garmin
https://uqwuhdwhzuqudnvubwep.supabase.co/functions/v1/watches/callback/coros
https://uqwuhdwhzuqudnvubwep.supabase.co/functions/v1/watches/callback/suunto
```

**Webhook URLs** (where the brand pushes new activities). `YOUR_WEBHOOK_KEY` is the secret you set in Supabase (see `watch-setup.md`):

```
https://uqwuhdwhzuqudnvubwep.supabase.co/functions/v1/watches/webhook/garmin?key=YOUR_WEBHOOK_KEY
https://uqwuhdwhzuqudnvubwep.supabase.co/functions/v1/watches/webhook/coros?key=YOUR_WEBHOOK_KEY
https://uqwuhdwhzuqudnvubwep.supabase.co/functions/v1/watches/webhook/suunto?key=YOUR_WEBHOOK_KEY
```

---

## Short description (all three)

> Runagotchi is a Tamagotchi-style running app. Each user raises a virtual pet that is fed by the kilometres they run: every kilometre is food, and the pet gets hungry and eventually faints if its owner stops running. Friends can see each other's pets, run together as a pack in an animated scene, and challenge each other to distances within a time limit (for example 20 km in one week), sending kudos and encouragement.
>
> Today users log runs by hand. We want users to connect their watch account so that completed runs feed their pet automatically.

## What data we need and why (all three)

> We only need completed **running** activities: start time, distance, duration and the activity ID (to avoid importing the same run twice). Other sports are discarded on receipt. We do not need GPS tracks, heart rate, health or sleep data.
>
> Runs are private to the user. Friends only see the pet's state (name, look, hunger level, level) and, inside a challenge the user joined, their total distance for that challenge. Individual activities are never shown to other users. No advertising, no analytics, no selling of data, no AI training. Data is stored in the EU (Supabase, Frankfurt). Users can disconnect at any time, which deletes their access tokens immediately.

---

## Garmin: Connect Developer Program (Starter Access)

**Where:** https://developer.garmin.com/gc-developer-program/overview → **Request now** (Starter Access).

**APIs to request:** Activity API only. Data delivery: push (activity summaries).

**Use case text:**

> Runagotchi (https://runagotchi.netlify.app) is a free, non-commercial running motivation app built by an individual developer in Austria. Users raise a virtual pet that is fed by the kilometres they run, and can see friends' pets and challenge friends to distances.
>
> We would like to use the Activity API (activity summaries via push) so that a user's completed runs automatically feed their pet after their Garmin device syncs. We only use running activities (start time, distance, duration, summary ID); everything else is discarded. Activities are only visible to the user who recorded them.
>
> Expected users: a small group of friends at first (under 50), growing slowly. The app is live and in use today with manual run entry; the backend for the Garmin connection (OAuth 2.0 PKCE, push endpoint, deregistration handling) is already built and waiting for credentials.
>
> Privacy policy: https://runagotchi.netlify.app/privacy.html

---

## COROS: Partner API (optional)

COROS already works without approval through its self-service connection (checked every 30 minutes). The Partner API would add instant push notifications. Apply when you want that.

**Where:** email **api@coros.com** and fill in COROS's application form (linked from https://support.coros.com/hc/en-us/articles/53181766856724).

**Email:**

> Subject: Partner API application – Runagotchi
>
> Hello COROS team,
>
> I'm Andreas Leutgeb, an individual developer from Austria. I'd like to apply for COROS Partner API access for Runagotchi (https://runagotchi.netlify.app), a free running motivation app where users raise a virtual pet that is fed by the kilometres they run, and challenge friends to distances.
>
> We would like COROS users to connect their account via OAuth 2.0 so that completed runs reach us through your workout webhook and feed their pet. We only need running workouts (start time, distance, duration, workout ID); other sports are discarded, and runs are only visible to the user who recorded them.
>
> Technical details:
> - OAuth 2.0 redirect URI: https://uqwuhdwhzuqudnvubwep.supabase.co/functions/v1/watches/callback/coros
> - Webhook endpoint: https://uqwuhdwhzuqudnvubwep.supabase.co/functions/v1/watches/webhook/coros?key=(provided on request)
> - Privacy policy: https://runagotchi.netlify.app/privacy.html
> - Technical contact: Andreas Leutgeb, andeleutgeb@gmail.com
>
> Expected users: a small group of friends at first, growing slowly. I'm happy to start in your sandbox environment.
>
> Thank you,
> Andreas Leutgeb

---

## Suunto: Partner Program (Suunto Cloud API)

**Where:** https://www.suunto.com → search "Suunto Partner Program" / "API" → apply and sign the API agreement. Approval gives access to APIzone, where you get the client ID, secret and subscription key.

**Application text:**

> Runagotchi (https://runagotchi.netlify.app) is a free, non-commercial running motivation app by an individual developer in Austria. Users raise a virtual pet that is fed by the kilometres they run; friends can see each other's pets and challenge each other to distances.
>
> We would like Suunto users to connect via OAuth 2.0 so that new running workouts (via workout webhook notifications, or fetching recent workouts on request) feed their pet automatically. We only use running workouts (start time, distance, duration, workout key); other sports are discarded, and workouts are only visible to the user who recorded them.
>
> OAuth redirect URI: https://uqwuhdwhzuqudnvubwep.supabase.co/functions/v1/watches/callback/suunto
> Notification URL: https://uqwuhdwhzuqudnvubwep.supabase.co/functions/v1/watches/webhook/suunto?key=(provided on request)
> Privacy policy: https://runagotchi.netlify.app/privacy.html
> Contact: Andreas Leutgeb, andeleutgeb@gmail.com
