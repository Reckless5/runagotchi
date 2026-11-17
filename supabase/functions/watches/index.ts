// Runagotchi "watches" server function (Supabase Edge Function).
//
// Connects Garmin, Suunto and COROS accounts and turns the runs those watches
// record into Runagotchi runs (which feed the pet).
//
//   POST /watches  {action: "providers"}                which brands are switched on
//   POST /watches  {action: "connect", provider}        -> {url} to the brand's login page
//   POST /watches  {action: "disconnect", provider}
//   POST /watches  {action: "sync", provider}           fetch new runs now (COROS, Suunto)
//   POST /watches  {action: "diagnose", provider}       what COROS offers (to tune the import)
//   GET  /watches/callback/<provider>                   the brand sends the user back here after login
//   POST /watches/webhook/<provider>?key=WEBHOOK_KEY    Garmin/Suunto push new activities here
//   POST /watches/cron?key=WEBHOOK_KEY                  scheduled: fetch new COROS runs for everyone
//   GET  /watches/status                                health check for the brands (always "ok")
//
// Garmin and Suunto switch on when their secrets are set (Edge Functions → Secrets).
// COROS uses its self-service connection (OAuth 2.0 + MCP, no approval needed):
// the function registers itself with COROS on first use.
// Lines marked "CHECK" come from public sources; confirm them against the brand's docs.
//
// Deploy with "Verify JWT" turned OFF: the brands can't send a Supabase login.
// The function checks the user's login itself for the app actions.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// Config

const env = (k: string) => Deno.env.get(k) ?? "";
const SUPABASE_URL = env("SUPABASE_URL");
const APP_URL = env("APP_URL") || "https://runagotchi.netlify.app";
const WEBHOOK_KEY = env("WEBHOOK_KEY");
const FN_URL = `${SUPABASE_URL}/functions/v1/watches`;
const COROS_MCP = env("COROS_MCP_URL") || "https://mcp.coros.com/mcp";
const MCP_VERSION = "2025-06-18";
const H = 3.6e6, DAY = 24 * H;

export type ProviderId = "garmin" | "suunto" | "coros";
export type Activity = { externalId: string; startMs: number; km: number; durMin: number | null; isRun: boolean };
type Tokens = { access_token: string; refresh_token?: string; expires_in?: number; [k: string]: unknown };
type Client = { tokenUrl: string; clientId: string; clientSecret: string | null; auth: "body" | "basic" | "none"; extra?: Record<string, string> };

interface Provider {
  id: ProviderId;
  name: string;
  enabled(): boolean;
  client(db: SupabaseClient): Promise<Client>;
  authorizeUrl(db: SupabaseClient, state: string, challenge: string, redirect: string): Promise<string>;
  providerUserId(t: Tokens, appUserId: string): Promise<string>;
  apiHeaders?(): Record<string, string>;
}

// --- Garmin (Connect Developer Program, Activity API; OAuth 2.0 with PKCE) ---
const garmin: Provider = {
  id: "garmin", name: "Garmin",
  enabled: () => !!(env("GARMIN_CLIENT_ID") && env("GARMIN_CLIENT_SECRET")),
  client: () => Promise.resolve({
    tokenUrl: "https://diauth.garmin.com/di-oauth2-service/oauth/token", // CHECK
    clientId: env("GARMIN_CLIENT_ID"), clientSecret: env("GARMIN_CLIENT_SECRET"), auth: "body",
  }),
  authorizeUrl: (_db, state, challenge, redirect) => Promise.resolve("https://connect.garmin.com/oauth2Confirm?" + new URLSearchParams({ // CHECK
    client_id: env("GARMIN_CLIENT_ID"), response_type: "code", redirect_uri: redirect,
    state, code_challenge: challenge, code_challenge_method: "S256",
  })),
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
  client: () => Promise.resolve({
    tokenUrl: "https://cloudapi-oauth.suunto.com/oauth/token", // CHECK
    clientId: env("SUUNTO_CLIENT_ID"), clientSecret: env("SUUNTO_CLIENT_SECRET"), auth: "basic",
  }),
  authorizeUrl: (_db, state, _c, redirect) => Promise.resolve("https://cloudapi-oauth.suunto.com/oauth/authorize?" + new URLSearchParams({ // CHECK
    client_id: env("SUUNTO_CLIENT_ID"), response_type: "code", redirect_uri: redirect, state,
  })),
  providerUserId: (t) => Promise.resolve(String(t.user ?? t.username ?? "")), // the token response names the Suunto user
  apiHeaders: () => ({ "Ocp-Apim-Subscription-Key": env("SUUNTO_SUBSCRIPTION_KEY") }),
};

// --- COROS (self-service: OAuth 2.0 against the COROS MCP endpoint) ---
// Standard MCP authorization: find the login server from the MCP endpoint's
// metadata, register Runagotchi once (dynamic client registration), then a
// normal OAuth 2.0 login with PKCE for each user.
async function fetchJson(url: string) {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return await r.json();
}
export async function discoverCoros() {
  const base = new URL(COROS_MCP);
  let authServer: string | null = null, scopes: string[] | undefined;
  // 1) Protected resource metadata (RFC 9728), directly or via the 401 challenge.
  for (const u of [`${base.origin}/.well-known/oauth-protected-resource${base.pathname}`, `${base.origin}/.well-known/oauth-protected-resource`]) {
    try { const j = await fetchJson(u); authServer = j.authorization_servers?.[0] ?? null; scopes = j.scopes_supported; if (authServer) break; } catch { /* try next */ }
  }
  if (!authServer) {
    try {
      const r = await fetch(COROS_MCP, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }) });
      const m = (r.headers.get("www-authenticate") ?? "").match(/resource_metadata="([^"]+)"/);
      await r.body?.cancel();
      if (m) { const j = await fetchJson(m[1]); authServer = j.authorization_servers?.[0] ?? null; scopes = j.scopes_supported; }
    } catch { /* fall back to the MCP origin */ }
  }
  authServer ??= base.origin;
  // 2) Authorization server metadata (RFC 8414 / OpenID discovery).
  const a = new URL(authServer), path = a.pathname === "/" ? "" : a.pathname.replace(/\/$/, "");
  for (const u of [`${a.origin}/.well-known/oauth-authorization-server${path}`, `${a.origin}/.well-known/openid-configuration${path}`, `${a.origin}${path}/.well-known/openid-configuration`]) {
    try {
      const m = await fetchJson(u);
      if (m.authorization_endpoint && m.token_endpoint) return { ...m, scopes_supported: scopes ?? m.scopes_supported } as Record<string, any>;
    } catch { /* try next */ }
  }
  throw new Error("COROS login server not found");
}
async function corosClientRow(db: SupabaseClient) {
  const { data } = await db.from("oauth_clients").select("*").eq("provider", "coros").maybeSingle();
  if (data) return data;
  const meta = await discoverCoros();
  if (!meta.registration_endpoint) throw new Error("COROS offers no self-registration");
  const methods: string[] = meta.token_endpoint_auth_methods_supported ?? ["none"];
  const wanted = methods.includes("none") ? "none" : methods.includes("client_secret_post") ? "client_secret_post" : "client_secret_basic";
  const r = await fetch(meta.registration_endpoint, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "Runagotchi", client_uri: APP_URL, policy_uri: `${APP_URL}/privacy.html`,
      redirect_uris: [`${FN_URL}/callback/coros`], grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"], token_endpoint_auth_method: wanted,
      ...(meta.scopes_supported ? { scope: meta.scopes_supported.join(" ") } : {}),
    }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`COROS registration: ${r.status} ${text.slice(0, 200)}`);
  const reg = JSON.parse(text);
  const row = {
    provider: "coros", client_id: reg.client_id, client_secret: reg.client_secret ?? null,
    auth_method: reg.token_endpoint_auth_method ?? wanted,
    meta: { authorization_endpoint: meta.authorization_endpoint, token_endpoint: meta.token_endpoint, scopes_supported: meta.scopes_supported ?? null },
  };
  const { error } = await db.from("oauth_clients").upsert(row);
  if (error) throw error;
  return row;
}
const coros: Provider = {
  id: "coros", name: "COROS",
  enabled: () => env("COROS_DISABLED") !== "1",
  async client(db) {
    const c = await corosClientRow(db);
    return {
      tokenUrl: c.meta.token_endpoint, clientId: c.client_id, clientSecret: c.client_secret,
      auth: c.auth_method === "client_secret_basic" ? "basic" : c.auth_method === "client_secret_post" ? "body" : "none",
      extra: { resource: COROS_MCP },
    };
  },
  async authorizeUrl(db, state, challenge, redirect) {
    const c = await corosClientRow(db);
    const q: Record<string, string> = {
      client_id: c.client_id, response_type: "code", redirect_uri: redirect, state,
      code_challenge: challenge, code_challenge_method: "S256", resource: COROS_MCP,
    };
    if (c.meta.scopes_supported?.length) q.scope = c.meta.scopes_supported.join(" ");
    return c.meta.authorization_endpoint + (c.meta.authorization_endpoint.includes("?") ? "&" : "?") + new URLSearchParams(q);
  },
  // The login doesn't name the COROS user, but the access token usually does.
  providerUserId: (t, appUserId) => Promise.resolve(jwtSubject(t.access_token) ?? (t.id_token ? jwtSubject(String(t.id_token)) : null) ?? `app:${appUserId}`),
};

export const PROVIDERS: Record<ProviderId, Provider> = { garmin, suunto, coros };

// ---------------------------------------------------------------------------
// MCP client (Streamable HTTP transport) for COROS

export function parseSse(text: string, id: number) {
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
    if (!data) continue;
    try { const msg = JSON.parse(data); if (msg.id === id) return msg; } catch { /* not JSON */ }
  }
  throw new Error("no response in event stream");
}
class AuthError extends Error {}
async function mcpSession(token: string) {
  let sid: string | null = null, nextId = 0;
  const rpc = async (method: string, params: unknown = {}, notify = false): Promise<any> => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`, "Content-Type": "application/json",
      Accept: "application/json, text/event-stream", "MCP-Protocol-Version": MCP_VERSION,
    };
    if (sid) headers["Mcp-Session-Id"] = sid;
    const msg: any = notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: ++nextId, method, params };
    const r = await fetch(COROS_MCP, { method: "POST", headers, body: JSON.stringify(msg) });
    sid = r.headers.get("mcp-session-id") ?? sid;
    if (r.status === 401) { await r.body?.cancel(); throw new AuthError("COROS login expired"); }
    if (notify) { await r.body?.cancel(); return null; }
    if (!r.ok) throw new Error(`COROS ${method}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const resp = (r.headers.get("content-type") ?? "").includes("text/event-stream") ? parseSse(await r.text(), msg.id) : await r.json();
    if (resp.error) throw new Error(`COROS ${method}: ${resp.error.message ?? JSON.stringify(resp.error)}`);
    return resp.result;
  };
  await rpc("initialize", { protocolVersion: MCP_VERSION, capabilities: {}, clientInfo: { name: "runagotchi", version: "1.0" } });
  await rpc("notifications/initialized", {}, true);
  return rpc;
}

// Pick the tool that lists activities and fill in its date arguments.
export function pickActivityTool(tools: any[]) {
  const scored = tools.map((t) => {
    const txt = `${t.name} ${t.description ?? ""}`;
    let s = 0;
    if (/activit|workout|exercise|training record|sport record/i.test(t.name)) s += 4;
    if (/activit|workout/i.test(txt)) s += 2;
    if (/list|query|records|search|history|recent|get/i.test(t.name)) s += 2;
    if (/detail|fit|file|lap|segment|track|gps|create|delete|update|write|plan|upload|sleep|hrv|health/i.test(t.name)) s -= 5;
    return { t, s };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  return scored[0]?.t ?? null;
}
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (ms: number, sep: string) => { const d = new Date(ms); return `${d.getUTCFullYear()}${sep}${pad(d.getUTCMonth() + 1)}${sep}${pad(d.getUTCDate())}`; };
export function activityArgs(tool: any, fromMs: number, toMs: number) {
  const props: Record<string, any> = tool?.inputSchema?.properties ?? {};
  const args: Record<string, unknown> = {};
  const dateValue = (p: any, ms: number) => {
    const desc = `${p.description ?? ""} ${p.format ?? ""} ${p.pattern ?? ""}`;
    if (p.type === "integer" || p.type === "number") {
      if (/yyyymmdd/i.test(desc)) return Number(ymd(ms, ""));
      return /milli|\bms\b/i.test(desc) ? ms : Math.floor(ms / 1000);
    }
    if (/yyyymmdd/i.test(desc) && !/yyyy-mm-dd/i.test(desc)) return ymd(ms, "");
    if (/date-time|iso ?8601|timestamp|hh:mm/i.test(desc)) return new Date(ms).toISOString();
    return ymd(ms, "-");
  };
  for (const [k, p] of Object.entries(props)) {
    if (/(start|from|begin|since|after)/i.test(k) && /(date|day|time|at|$)/i.test(k)) args[k] = dateValue(p, fromMs);
    else if (/(end|to|until|before)/i.test(k) && /(date|day|time|at|$)/i.test(k)) args[k] = dateValue(p, toMs);
    else if (/^(limit|size|pagesize|page_size|count|max)/i.test(k)) args[k] = Math.min(Number(p.maximum ?? 100), 100);
    else if (/^(page|pagenum|page_number|pageno)$/i.test(k)) args[k] = 1;
    else if (/sport|type/i.test(k) && Array.isArray(p.enum)) { const run = p.enum.find((v: unknown) => /run/i.test(String(v))); if (run !== undefined) args[k] = run; }
  }
  return args;
}

// Find activities anywhere in a tool result: objects with a distance and a start time.
const COROS_RUN_CODES = new Set((env("COROS_RUN_SPORT_TYPES") || "100,101,102,103").split(",").map((x) => Number(x.trim())));
function toMs(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number" || /^\d+$/.test(String(v))) {
    const n = Number(v);
    if (n >= 19000101 && n <= 21001231) { const s = String(n); return Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), 12); } // YYYYMMDD
    if (n > 1e12) return n;
    if (n > 1e9) return n * 1000;
    return null;
  }
  const t = Date.parse(String(v).replace(" ", "T"));
  return isNaN(t) ? null : t;
}
export function extractActivities(result: any): Activity[] {
  const roots: unknown[] = [];
  if (result?.structuredContent) roots.push(result.structuredContent);
  for (const c of result?.content ?? []) {
    if (c?.type !== "text" || !c.text) continue;
    try { roots.push(JSON.parse(c.text)); } catch {
      const m = c.text.match(/[\[{][\s\S]*[\]}]/);
      if (m) { try { roots.push(JSON.parse(m[0])); } catch { /* prose */ } }
    }
  }
  const out = new Map<string, Activity>();
  const pick = (o: Record<string, unknown>, re: RegExp) => Object.keys(o).find((k) => re.test(k));
  const visit = (v: unknown, depth: number) => {
    if (depth > 6 || v == null) return;
    if (Array.isArray(v)) { v.forEach((x) => visit(x, depth + 1)); return; }
    if (typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    const dk = pick(o, /^(total_?)?distance(_?(km|meters?|m))?$/i) ?? pick(o, /distance/i);
    const sk = pick(o, /^(start_?(time|date|timestamp)?|begin_?time|date|start_?at|local_?start)$/i) ?? pick(o, /start/i);
    if (dk && sk && (typeof o[dk] === "number" || /^[\d.]+$/.test(String(o[dk])))) {
      let km = Number(o[dk]);
      if (/km/i.test(dk)) { /* already km */ } else if (/meter|_m$|M$/i.test(dk) || km > 300) km = km / 1000;
      const startMs = toMs(o[sk]);
      const tk = pick(o, /^(total_?)?(time|duration|elapsed_?time|moving_?time|workout_?time)(_?(s|sec|seconds|in_?seconds))?$/i);
      let dur = tk ? Number(o[tk]) : NaN;
      if (tk && /ms|milli/i.test(tk)) dur = dur / 1000;
      const typeKey = pick(o, /^(sport_?(type|name)?|activity_?type|type|mode|sport_?mode|name)$/i);
      const tv = typeKey ? o[typeKey] : undefined;
      const isRun = tv == null ? true : (typeof tv === "number" || /^\d+$/.test(String(tv))) ? COROS_RUN_CODES.has(Number(tv)) : /run/i.test(String(tv));
      const idKey = pick(o, /^(label_?id|activity_?id|workout_?id|id|uuid)$/i);
      if (startMs && km > 0) {
        const externalId = String(idKey ? o[idKey] : `${startMs}-${km}`);
        out.set(externalId, { externalId, startMs, km, durMin: isFinite(dur) && dur > 0 ? dur / 60 : null, isRun });
      }
      return;
    }
    Object.values(o).forEach((x) => visit(x, depth + 1));
  };
  roots.forEach((r) => visit(r, 0));
  return [...out.values()];
}

// ---------------------------------------------------------------------------
// Turning Garmin / Suunto payloads into runs (pure functions, unit-tested)

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

const FOOD_PER_KM = 10, MAX_FOOD = 100, START_FOOD = 70, GRACE_H = 72, REVIVE_KM = 5;
const WEEK_KM: Record<string, number> = { easy: 10, normal: 20, hard: 35 };
export function simulate(bornMs: number, difficulty: string, runs: { date: number; km: number }[], tNow: number, debug?: { food: number; at: number } | null) {
  const decayH = (WEEK_KM[difficulty] ?? 20) * FOOD_PER_KM / 7 / 24;
  let t = bornMs, f = START_FOOD, dead = false, zeroAt: number | null = null, deathAt: number | null = null, fedKm = 0;
  if (debug) { // test accounts: "at debug.at the pet had debug.food food"
    fedKm = runs.filter((r) => r.date >= bornMs && r.date < debug.at).reduce((a, r) => a + r.km, 0);
    t = debug.at; f = Math.max(0, Math.min(MAX_FOOD, debug.food)); if (f === 0) zeroAt = t;
    runs = runs.filter((r) => r.date >= debug.at);
  }
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
  const { data: pet } = await db.from("pets").select("*").eq("user_id", userId).maybeSingle();
  if (!pet) return;
  const { data: runs } = await db.from("runs").select("started_at,km").eq("user_id", userId);
  const now = Date.now();
  const debug = pet.debug_at && pet.debug_food != null ? { food: Number(pet.debug_food), at: Date.parse(pet.debug_at) } : null;
  const sim = simulate(Date.parse(pet.born_at), pet.difficulty, (runs ?? []).map((r) => ({ date: Date.parse(r.started_at), km: Number(r.km) })), now, debug);
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
export function jwtSubject(token: string): string | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const p = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=")));
    const sub = p.sub ?? p.user_id ?? p.userId ?? p.uid ?? p.openId;
    return sub ? String(sub) : null;
  } catch { return null; }
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
let dbFactory = (): SupabaseClient => createClient(SUPABASE_URL, env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const admin = () => dbFactory();
export const __test = { setDb(db: unknown) { dbFactory = () => db as SupabaseClient; } }; // tests only

async function userFrom(req: Request, db: SupabaseClient) {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data } = await db.auth.getUser(jwt);
  return data.user ?? null;
}

async function tokenRequest(db: SupabaseClient, p: Provider, params: Record<string, string>): Promise<Tokens> {
  const c = await p.client(db);
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  const body = new URLSearchParams({ ...params, ...(c.extra ?? {}) });
  if (c.auth === "basic") headers.Authorization = "Basic " + btoa(`${c.clientId}:${c.clientSecret ?? ""}`);
  else { body.set("client_id", c.clientId); if (c.auth === "body" && c.clientSecret) body.set("client_secret", c.clientSecret); }
  const r = await fetch(c.tokenUrl, { method: "POST", headers, body });
  const text = await r.text();
  if (!r.ok) throw new Error(`${p.name} token: ${r.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

// A valid access token for this user, refreshed when it is about to expire.
async function accessToken(db: SupabaseClient, userId: string, p: Provider, force = false) {
  const { data: row } = await db.from("watch_tokens").select("*").eq("user_id", userId).eq("provider", p.id).maybeSingle();
  if (!row) throw new Error("not connected");
  const fresh = !row.expires_at || Date.parse(row.expires_at) - Date.now() > 5 * 60000;
  if ((!force && fresh) || !row.refresh_token) return row.access_token as string;
  const t = await tokenRequest(db, p, { grant_type: "refresh_token", refresh_token: row.refresh_token });
  await db.from("watch_tokens").update({
    access_token: t.access_token, refresh_token: t.refresh_token ?? row.refresh_token,
    expires_at: t.expires_in ? new Date(Date.now() + t.expires_in * 1000).toISOString() : null, updated_at: new Date().toISOString(),
  }).eq("user_id", userId).eq("provider", p.id);
  return t.access_token;
}

// Save runs (duplicates ignored), then update the pet and the "last sync" time.
async function importActivities(db: SupabaseClient, userId: string, p: ProviderId, acts: Activity[], notBefore = 0) {
  const runs = acts.filter((a) => a.isRun && a.km > 0.05 && a.km <= 400 && a.startMs >= notBefore && a.startMs <= Date.now() + 60000).map((a) => ({
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
// Pulling runs: COROS (MCP) and Suunto

async function corosSession(db: SupabaseClient, userId: string) {
  try { return await mcpSession(await accessToken(db, userId, coros)); }
  catch (e) { if (e instanceof AuthError) return await mcpSession(await accessToken(db, userId, coros, true)); throw e; }
}
async function syncCoros(db: SupabaseClient, userId: string, diagnose = false) {
  const { data: link } = await db.from("watch_links").select("connected_at,last_sync_at").eq("user_id", userId).eq("provider", "coros").maybeSingle();
  if (!link) throw new Error("not connected");
  const connected = Date.parse(link.connected_at);
  const from = Math.max(connected, (link.last_sync_at ? Date.parse(link.last_sync_at) : connected) - 2 * DAY) - DAY;
  const to = Date.now() + DAY;
  const rpc = await corosSession(db, userId);
  const tools: any[] = (await rpc("tools/list", {})).tools ?? [];
  const tool = pickActivityTool(tools);
  if (!tool) {
    if (diagnose) return { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })), picked: null };
    throw new Error("COROS: no activity tool found");
  }
  const args = activityArgs(tool, from, to);
  const result = await rpc("tools/call", { name: tool.name, arguments: args });
  const acts = extractActivities(result);
  if (diagnose) {
    return {
      tools: tools.map((t) => ({ name: t.name, description: (t.description ?? "").slice(0, 300), inputSchema: t.inputSchema })),
      picked: tool.name, args, found: acts, raw: JSON.stringify(result).slice(0, 4000),
    };
  }
  return { imported: await importActivities(db, userId, "coros", acts, connected) };
}
async function syncSuunto(db: SupabaseClient, userId: string) {
  const tok = await accessToken(db, userId, suunto);
  const { data: link } = await db.from("watch_links").select("connected_at").eq("user_id", userId).eq("provider", "suunto").maybeSingle();
  const since = link ? Date.parse(link.connected_at) : Date.now() - 7 * DAY;
  const r = await fetch(`${SUUNTO_API}/workouts?since=${since}&limit=100`, { headers: { Authorization: `Bearer ${tok}`, ...suunto.apiHeaders!() } }); // CHECK
  if (!r.ok) throw new Error(`Suunto workouts: ${r.status}`);
  const payload = await r.json();
  const acts = (payload.payload ?? payload.workouts ?? []).map(suuntoWorkoutToActivity).filter(Boolean) as Activity[];
  return { imported: await importActivities(db, userId, "suunto", acts, since) };
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
    const url = await p.authorizeUrl(db, state, await pkceChallenge(verifier), `${FN_URL}/callback/${p.id}`);
    const { error } = await db.from("oauth_states").insert({ state, user_id: user.id, provider: p.id, code_verifier: verifier });
    if (error) throw error;
    return json({ url });
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
    if (p.id === "coros") return json(await syncCoros(db, user.id));
    if (p.id === "suunto") return json(await syncSuunto(db, user.id));
    return json({ imported: 0, note: `${p.name} sends new runs automatically.` });
  }
  if (body.action === "diagnose" && p.id === "coros") {
    try { return json(await syncCoros(db, user.id, true)); }
    catch (e) { return json({ error: String((e as Error).message ?? e) }); }
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
    if (p.id !== "suunto") params.code_verifier = st.code_verifier; // Garmin and COROS use PKCE
    const t = await tokenRequest(db, p, params);
    const providerUserId = await p.providerUserId(t, st.user_id);
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
    console.log("COROS webhook received (Partner API not set up)", raw.slice(0, 500));
  }
  return json({ ok: true, imported });
}

// Scheduled: fetch new COROS runs for everyone who hasn't synced in a while.
async function handleCron(url: URL, db: SupabaseClient) {
  if (!safeEqual(url.searchParams.get("key") ?? "", WEBHOOK_KEY)) return json({ error: "forbidden" }, 403);
  const stale = new Date(Date.now() - 25 * 60000).toISOString();
  const { data: links } = await db.from("watch_links").select("user_id,last_sync_at").eq("provider", "coros")
    .or(`last_sync_at.is.null,last_sync_at.lt.${stale}`).order("last_sync_at", { ascending: true, nullsFirst: true }).limit(25);
  let imported = 0, failed = 0;
  for (const l of links ?? []) {
    try { imported += (await syncCoros(db, l.user_id) as { imported: number }).imported; }
    catch (e) { failed++; console.error("cron coros", l.user_id, e); }
  }
  return json({ ok: true, users: (links ?? []).length, imported, failed });
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
    if (route === "cron" && req.method === "POST") return await handleCron(url, db);
    if (route === "status" && req.method === "GET") return json({ ok: true, service: "runagotchi-watches", time: new Date().toISOString() });
    const p = PROVIDERS[pid as ProviderId];
    if (!p) return json({ error: "not found" }, 404);
    if (route === "callback" && req.method === "GET") return await handleCallback(url, p, db);
    if (route === "webhook" && req.method === "POST") return await handleWebhook(req, url, p, db);
    return json({ error: "not found" }, 404);
  } catch (e) {
    console.error(e);
    const msg = String((e as Error)?.message ?? e);
    return json({ error: /COROS/.test(msg) ? msg : "Something went wrong. Try again in a moment." }, 500);
  }
}

if (!Deno.env.get("RUNAGOTCHI_TEST")) Deno.serve(handler);
