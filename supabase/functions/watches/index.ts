// Runagotchi "watches" server function (Supabase Edge Function).
//
// Connects Garmin, Suunto and COROS accounts and turns the runs those watches
// send us into Runagotchi runs (which feed the pet).
//
//   POST /watches                       {action: "providers"}            which brands are switched on
//   POST /watches                       {action: "connect", provider}    -> {url} to the brand's login page
//   POST /watches                       {action: "disconnect", provider}
//   POST /watches                       {action: "sync", provider}       pull recent runs (Suunto)
//   GET  /watches/callback/<provider>   the brand sends the user back here after login
//   POST /watches/webhook/<provider>?key=WEBHOOK_KEY   the brand pushes new activities here
//
// A brand is switched on as soon as its secrets are set (Edge Functions → Secrets).
// Endpoints marked "CHECK" come from public sources; confirm them against the
// brand's developer docs once your access is approved.
//
// Deploy with "Verify JWT" turned OFF: the brands can't send a Supabase login.
// The function checks the user's login itself for connect/disconnect/sync.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// Config

const env = (k: string) => Deno.env.get(k) ?? "";
const SUPABASE_URL = env("SUPABASE_URL");
const APP_URL = env("APP_URL") || "https://runagotchi.netlify.app";
const WEBHOOK_KEY = env("WEBHOOK_KEY");
const FN_URL = `${SUPABASE_URL}/functions/v1/watches`;

export type ProviderId = "garmin" | "suunto" | "coros";
export type Activity = { externalId: string; startMs: number; km: number; durMin: number | null; isRun: boolean };
type Tokens = { access_token: string; refresh_token?: string; expires_in?: number; [k: string]: unknown };

interface Provider {
  id: ProviderId;
  name: string;
  enabled(): boolean;
  authorizeUrl(state: string, challenge: string, redirect: string): string;
  tokenUrl(): string;
  tokenAuth: "body" | "basic";
  usesPkce: boolean;
  providerUserId(t: Tokens): Promise<string>;
  apiHeaders?(): Record<string, string>;
}

// --- Garmin (Connect Developer Program, Activity API; OAuth 2.0 with PKCE) ---
const garmin: Provider = {
  id: "garmin", name: "Garmin",
  enabled: () => !!(env("GARMIN_CLIENT_ID") && env("GARMIN_CLIENT_SECRET")),
  // CHECK: Garmin OAuth2 PKCE spec
  authorizeUrl: (state, challenge, redirect) => "https://connect.garmin.com/oauth2Confirm?" + new URLSearchParams({
    client_id: env("GARMIN_CLIENT_ID"), response_type: "code", redirect_uri: redirect,
    state, code_challenge: challenge, code_challenge_method: "S256",
  }),
  tokenUrl: () => "https://diauth.garmin.com/di-oauth2-service/oauth/token", // CHECK
  tokenAuth: "body", usesPkce: true,
  async providerUserId(t) {
    const r = await fetch("https://apis.garmin.com/wellness-api/rest/user/id", { headers: { Authorization: `Bearer ${t.access_token}` } }); // CHECK
    if (!r.ok) throw new Error(`Garmin user id: ${r.status}`);
    return String((await r.json()).userId);
  },
};

// --- Suunto (Partner Program, Suunto Cloud API; OAuth 2.0) ---
const SUUNTO_API = "https://cloudapi.suunto.com/v2"; // CHECK
const suunto: Provider = {
  id: "suunto", name: "Suunto",
  enabled: () => !!(env("SUUNTO_CLIENT_ID") && env("SUUNTO_CLIENT_SECRET") && env("SUUNTO_SUBSCRIPTION_KEY")),
  authorizeUrl: (state, _c, redirect) => "https://cloudapi-oauth.suunto.com/oauth/authorize?" + new URLSearchParams({ // CHECK
    client_id: env("SUUNTO_CLIENT_ID"), response_type: "code", redirect_uri: redirect, state,
  }),
  tokenUrl: () => "https://cloudapi-oauth.suunto.com/oauth/token", // CHECK
  tokenAuth: "basic", usesPkce: false,
  providerUserId: (t) => Promise.resolve(String(t.user ?? t.username ?? "")), // the token response names the Suunto user
  apiHeaders: () => ({ "Ocp-Apim-Subscription-Key": env("SUUNTO_SUBSCRIPTION_KEY") }),
};

// --- COROS (Partner API; OAuth 2.0). COROS shares its docs after approval, so
// every endpoint is a secret you fill in from those docs. ---
const coros: Provider = {
  id: "coros", name: "COROS",
  enabled: () => !!(env("COROS_CLIENT_ID") && env("COROS_CLIENT_SECRET") && env("COROS_AUTHORIZE_URL") && env("COROS_TOKEN_URL")),
  authorizeUrl: (state, _c, redirect) => env("COROS_AUTHORIZE_URL") + "?" + new URLSearchParams({
    client_id: env("COROS_CLIENT_ID"), response_type: "code", redirect_uri: redirect, state,
  }),
  tokenUrl: () => env("COROS_TOKEN_URL"),
  tokenAuth: "body", usesPkce: false,
  providerUserId: (t) => Promise.resolve(String(t.openId ?? t.open_id ?? t.user_id ?? t.userId ?? "")),
};

export const PROVIDERS: Record<ProviderId, Provider> = { garmin, suunto, coros };

// ---------------------------------------------------------------------------
// Turning brand payloads into runs (pure functions, unit-tested)

const isRunType = (t: unknown) => /run/i.test(String(t ?? ""));

// Garmin pushes {activities: [...]} (Activity API summaries) and {deregistrations: [...]}.
export function parseGarminPush(body: any): { byUser: Record<string, Activity[]>; deregistered: string[] } {
  const byUser: Record<string, Activity[]> = {};
  for (const a of body?.activities ?? body?.activityDetails?.map((d: any) => d.summary ?? d) ?? []) {
    if (!a?.userId) continue;
    const act: Activity = {
      externalId: String(a.summaryId ?? a.activityId ?? `${a.startTimeInSeconds}`),
      startMs: Number(a.startTimeInSeconds) * 1000,
      km: Number(a.distanceInMeters ?? 0) / 1000,
      durMin: a.durationInSeconds ? Number(a.durationInSeconds) / 60 : null,
      isRun: isRunType(a.activityType),
    };
    (byUser[String(a.userId)] ??= []).push(act);
  }
  const deregistered = (body?.deregistrations ?? []).map((d: any) => String(d.userId)).filter(Boolean);
  return { byUser, deregistered };
}

// Suunto activity ids that count as running. CHECK against Suunto's activity list.
const SUUNTO_RUN_IDS = new Set((env("SUUNTO_RUN_ACTIVITY_IDS") || "3,22,67,93").split(",").map((x) => Number(x.trim())));
export function suuntoWorkoutToActivity(w: any): Activity | null {
  if (!w) return null;
  const key = w.workoutKey ?? w.workoutId ?? w.id;
  if (!key) return null;
  const start = typeof w.startTime === "number" ? w.startTime : Date.parse(w.startTime);
  return {
    externalId: String(key), startMs: start,
    km: Number(w.totalDistance ?? 0) / 1000,
    durMin: w.totalTime ? Number(w.totalTime) / 60 : null,
    isRun: SUUNTO_RUN_IDS.has(Number(w.activityId)) || isRunType(w.activityName ?? w.sport),
  };
}

// ---------------------------------------------------------------------------
// Pet snapshot (same rules as js/app.js) so friends see the fed pet right away

const FOOD_PER_KM = 10, MAX_FOOD = 100, START_FOOD = 70, GRACE_H = 72, REVIVE_KM = 5, H = 3.6e6;
const WEEK_KM: Record<string, number> = { easy: 10, normal: 20, hard: 35 };
export function simulate(bornMs: number, difficulty: string, runs: { date: number; km: number }[], tNow: number) {
  const decayH = (WEEK_KM[difficulty] ?? 20) * FOOD_PER_KM / 7 / 24;
  let t = bornMs, f = START_FOOD, dead = false, zeroAt: number | null = null, deathAt: number | null = null, fedKm = 0;
  const adv = (to: number) => {
    if (to <= t) return;
    if (!dead) {
      const h = (to - t) / H;
      if (f > 0) { const hz = f / decayH; if (h < hz) f -= decayH * h; else { zeroAt = t + hz * H; f = 0; } }
      if (f === 0 && zeroAt !== null && to - zeroAt >= GRACE_H * H) { dead = true; deathAt = zeroAt + GRACE_H * H; }
    }
    t = to;
  };
  for (const r of runs.filter((r) => r.date >= bornMs && r.date <= tNow).sort((a, b) => a.date - b.date)) {
    adv(r.date);
    if (dead) { if (r.km >= REVIVE_KM) { dead = false; deathAt = null; zeroAt = null; f = Math.min(MAX_FOOD, r.km * FOOD_PER_KM); fedKm += r.km; } }
    else { f = Math.min(MAX_FOOD, f + r.km * FOOD_PER_KM); if (f > 0) zeroAt = null; fedKm += r.km; }
  }
  adv(tNow);
  return { f, dead, zeroAt, deathAt, fedKm };
}
const stageOf = (km: number) => km < 25 ? "baby" : km < 100 ? "kid" : "grown";
const levelOf = (km: number) => Math.floor(Math.sqrt(km / 2)) + 1;

async function refreshSnapshot(db: SupabaseClient, userId: string) {
  const { data: pet } = await db.from("pets").select("born_at,difficulty").eq("user_id", userId).maybeSingle();
  if (!pet) return;
  const { data: runs } = await db.from("runs").select("started_at,km").eq("user_id", userId);
  const now = Date.now();
  const sim = simulate(Date.parse(pet.born_at), pet.difficulty, (runs ?? []).map((r) => ({ date: Date.parse(r.started_at), km: Number(r.km) })), now);
  const iso = (t: number | null) => t == null ? null : new Date(t).toISOString();
  await db.from("pets").update({
    food: Math.round(sim.f * 100) / 100, zero_at: iso(sim.zeroAt), dead: sim.dead, death_at: iso(sim.deathAt),
    level: levelOf(sim.fedKm), stage: stageOf(sim.fedKm), snapshot_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(),
  }).eq("user_id", userId);
}

// ---------------------------------------------------------------------------
// Helpers

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const redirect = (url: string) => new Response(null, { status: 302, headers: { Location: url } });
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomString = (n = 48) => b64url(crypto.getRandomValues(new Uint8Array(n)));
export async function pkceChallenge(verifier: string) {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}
function safeEqual(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function hmacHex(secret: string, body: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const admin = () => createClient(SUPABASE_URL, env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

async function userFrom(req: Request, db: SupabaseClient) {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data } = await db.auth.getUser(jwt);
  return data.user ?? null;
}

async function tokenRequest(p: Provider, params: Record<string, string>): Promise<Tokens> {
  const id = env(`${p.id.toUpperCase()}_CLIENT_ID`), secret = env(`${p.id.toUpperCase()}_CLIENT_SECRET`);
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  const body = new URLSearchParams(params);
  if (p.tokenAuth === "basic") headers.Authorization = "Basic " + btoa(`${id}:${secret}`);
  else { body.set("client_id", id); body.set("client_secret", secret); }
  const r = await fetch(p.tokenUrl(), { method: "POST", headers, body });
  const text = await r.text();
  if (!r.ok) throw new Error(`${p.name} token: ${r.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

// A valid access token for this user, refreshed when it is about to expire.
async function accessToken(db: SupabaseClient, userId: string, p: Provider) {
  const { data: row } = await db.from("watch_tokens").select("*").eq("user_id", userId).eq("provider", p.id).maybeSingle();
  if (!row) throw new Error("not connected");
  if (!row.expires_at || Date.parse(row.expires_at) - Date.now() > 5 * 60000 || !row.refresh_token) return row.access_token as string;
  const t = await tokenRequest(p, { grant_type: "refresh_token", refresh_token: row.refresh_token });
  await db.from("watch_tokens").update({
    access_token: t.access_token, refresh_token: t.refresh_token ?? row.refresh_token,
    expires_at: t.expires_in ? new Date(Date.now() + t.expires_in * 1000).toISOString() : null, updated_at: new Date().toISOString(),
  }).eq("user_id", userId).eq("provider", p.id);
  return t.access_token;
}

// Save runs (duplicates ignored), then update the pet and the "last sync" time.
async function importActivities(db: SupabaseClient, userId: string, p: ProviderId, acts: Activity[]) {
  const runs = acts.filter((a) => a.isRun && a.km > 0.05 && a.km <= 400 && a.startMs > 0).map((a) => ({
    user_id: userId, started_at: new Date(a.startMs).toISOString(), km: Math.round(a.km * 100) / 100,
    dur_min: a.durMin ? Math.round(a.durMin * 10) / 10 : null, source: p, external_id: a.externalId,
  }));
  if (runs.length) {
    const { error } = await db.from("runs").upsert(runs, { onConflict: "user_id,source,external_id", ignoreDuplicates: true });
    if (error) throw error;
    await refreshSnapshot(db, userId);
  }
  await db.from("watch_links").update({ last_sync_at: new Date().toISOString() }).eq("user_id", userId).eq("provider", p);
  return runs.length;
}
async function userForProviderAccount(db: SupabaseClient, p: ProviderId, providerUserId: string) {
  const { data } = await db.from("watch_tokens").select("user_id").eq("provider", p).eq("provider_user_id", providerUserId).maybeSingle();
  return data?.user_id as string | undefined;
}
async function unlink(db: SupabaseClient, userId: string, p: ProviderId) {
  await db.from("watch_tokens").delete().eq("user_id", userId).eq("provider", p);
  await db.from("watch_links").delete().eq("user_id", userId).eq("provider", p);
}

// ---------------------------------------------------------------------------
// Routes

async function handleAction(req: Request, db: SupabaseClient) {
  const body = await req.json().catch(() => ({}));
  if (body.action === "providers") {
    return json(Object.fromEntries(Object.values(PROVIDERS).map((p) => [p.id, p.enabled()])));
  }
  const user = await userFrom(req, db);
  if (!user) return json({ error: "Please log in again." }, 401);
  const p = PROVIDERS[body.provider as ProviderId];
  if (!p) return json({ error: "Unknown watch brand." }, 400);

  if (body.action === "connect") {
    if (!p.enabled()) return json({ error: `${p.name} isn't set up yet.` }, 400);
    await db.from("oauth_states").delete().lt("created_at", new Date(Date.now() - 3600_000).toISOString());
    const state = randomString(24), verifier = randomString(48);
    const { error } = await db.from("oauth_states").insert({ state, user_id: user.id, provider: p.id, code_verifier: verifier });
    if (error) throw error;
    return json({ url: p.authorizeUrl(state, await pkceChallenge(verifier), `${FN_URL}/callback/${p.id}`) });
  }
  if (body.action === "disconnect") {
    if (p.id === "garmin") {
      try { // let Garmin know, so it stops pushing this user's data. CHECK
        const tok = await accessToken(db, user.id, p);
        await fetch("https://apis.garmin.com/wellness-api/rest/user/registration", { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } });
      } catch (_) { /* unlink anyway */ }
    }
    await unlink(db, user.id, p.id);
    return json({ ok: true });
  }
  if (body.action === "sync") {
    if (p.id !== "suunto") return json({ imported: 0, note: `${p.name} sends new runs automatically.` });
    const tok = await accessToken(db, user.id, p);
    const { data: link } = await db.from("watch_links").select("connected_at").eq("user_id", user.id).eq("provider", p.id).maybeSingle();
    const since = link ? Date.parse(link.connected_at) : Date.now() - 7 * 24 * H;
    const r = await fetch(`${SUUNTO_API}/workouts?since=${since}&limit=100`, { headers: { Authorization: `Bearer ${tok}`, ...p.apiHeaders!() } }); // CHECK
    if (!r.ok) throw new Error(`Suunto workouts: ${r.status}`);
    const payload = await r.json();
    const acts = (payload.payload ?? payload.workouts ?? []).map(suuntoWorkoutToActivity).filter(Boolean) as Activity[];
    return json({ imported: await importActivities(db, user.id, p.id, acts) });
  }
  return json({ error: "Unknown action." }, 400);
}

async function handleCallback(url: URL, p: Provider, db: SupabaseClient) {
  const back = (status: string, reason = "") => redirect(`${APP_URL}/?watch=${p.id}&status=${status}${reason ? "&reason=" + encodeURIComponent(reason) : ""}`);
  const code = url.searchParams.get("code"), state = url.searchParams.get("state");
  if (url.searchParams.get("error") || !code || !state) return back("cancelled");
  const { data: st } = await db.from("oauth_states").select("*").eq("state", state).maybeSingle();
  await db.from("oauth_states").delete().eq("state", state);
  if (!st || st.provider !== p.id || Date.now() - Date.parse(st.created_at) > 15 * 60000) return back("error", "expired");
  try {
    const params: Record<string, string> = { grant_type: "authorization_code", code, redirect_uri: `${FN_URL}/callback/${p.id}` };
    if (p.usesPkce) params.code_verifier = st.code_verifier;
    const t = await tokenRequest(p, params);
    const providerUserId = await p.providerUserId(t);
    if (!providerUserId) throw new Error("no user id from " + p.name);
    const other = await userForProviderAccount(db, p.id, providerUserId);
    if (other && other !== st.user_id) return back("error", "already_linked");
    const { error } = await db.from("watch_tokens").upsert({
      user_id: st.user_id, provider: p.id, provider_user_id: providerUserId,
      access_token: t.access_token, refresh_token: t.refresh_token ?? null,
      expires_at: t.expires_in ? new Date(Date.now() + t.expires_in * 1000).toISOString() : null, updated_at: new Date().toISOString(),
    });
    if (error) throw error;
    await db.from("watch_links").upsert({ user_id: st.user_id, provider: p.id, connected_at: new Date().toISOString() });
    return back("ok");
  } catch (e) {
    console.error("callback", p.id, e);
    return back("error", "login_failed");
  }
}

async function handleWebhook(req: Request, url: URL, p: Provider, db: SupabaseClient) {
  if (!safeEqual(url.searchParams.get("key") ?? "", WEBHOOK_KEY)) return json({ error: "forbidden" }, 403);
  const raw = await req.text();
  let body: any = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { return json({ error: "bad json" }, 400); }
  let imported = 0;

  if (p.id === "garmin") {
    const { byUser, deregistered } = parseGarminPush(body);
    for (const [gid, acts] of Object.entries(byUser)) {
      const uid = await userForProviderAccount(db, "garmin", gid);
      if (uid) imported += await importActivities(db, uid, "garmin", acts);
    }
    for (const gid of deregistered) {
      const uid = await userForProviderAccount(db, "garmin", gid);
      if (uid) await unlink(db, uid, "garmin");
    }
  } else if (p.id === "suunto") {
    const secret = env("SUUNTO_WEBHOOK_SECRET");
    if (secret) { // CHECK header name in Suunto's webhook docs
      const sig = req.headers.get("X-HMAC-SHA256-Signature") ?? "";
      if (!safeEqual(sig.toLowerCase(), await hmacHex(secret, raw))) return json({ error: "bad signature" }, 401);
    }
    const username = String(body.username ?? body.user ?? "");
    const uid = username && await userForProviderAccount(db, "suunto", username);
    if (uid && /WORKOUT/i.test(String(body.type ?? "WORKOUT_CREATED"))) {
      let w = body.workout ?? body;
      if (w.totalDistance == null && w.workoutKey) { // notification without details: fetch the workout
        const tok = await accessToken(db, uid, suunto);
        const r = await fetch(`${SUUNTO_API}/workouts/${encodeURIComponent(w.workoutKey)}`, { headers: { Authorization: `Bearer ${tok}`, ...suunto.apiHeaders!() } }); // CHECK
        if (r.ok) { const j = await r.json(); w = j.payload ?? j; }
      }
      const act = suuntoWorkoutToActivity(w);
      if (act) imported += await importActivities(db, uid, "suunto", [act]);
    }
  } else {
    // COROS: the push format is in COROS's partner docs (shared after approval).
    console.log("COROS webhook received but not implemented yet", raw.slice(0, 500));
  }
  return json({ ok: true, imported });
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const i = parts.indexOf("watches");
  const [route, pid] = i >= 0 ? parts.slice(i + 1) : parts;
  const db = admin();
  try {
    if (!route && req.method === "POST") return await handleAction(req, db);
    const p = PROVIDERS[pid as ProviderId];
    if (!p) return json({ error: "not found" }, 404);
    if (route === "callback" && req.method === "GET") return await handleCallback(url, p, db);
    if (route === "webhook" && req.method === "POST") return await handleWebhook(req, url, p, db);
    return json({ error: "not found" }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: "Something went wrong. Try again in a moment." }, 500);
  }
}

if (!Deno.env.get("RUNAGOTCHI_TEST")) Deno.serve(handler);
