// End-to-end test of the COROS (MCP) connection against a fake COROS server
// and an in-memory database. Run:
//   RUNAGOTCHI_TEST=1 COROS_ENABLED=1 WEBHOOK_KEY=k SUPABASE_URL=http://fn.test SUPABASE_SERVICE_ROLE_KEY=x \
//   COROS_MCP_URL=http://localhost:8799/mcp deno test --allow-env --allow-net coros_flow_test.ts
import { deepStrictEqual as eq, ok } from "node:assert";
import { handler, __test, extractActivities, activityArgs, pickActivityTool, parseSse, jwtSubject } from "./index.ts";

// ---------- in-memory stand-in for the parts of supabase-js the function uses ----------
type Row = Record<string, any>;
const KEYS: Record<string, string[]> = {
  oauth_clients: ["provider"], oauth_states: ["state"], watch_tokens: ["user_id", "provider"],
  watch_links: ["user_id", "provider"], runs: ["user_id", "source", "external_id"], pets: ["user_id"],
};
function fakeDb(tables: Record<string, Row[]>) {
  const from = (t: string) => {
    tables[t] ??= [];
    let op = "select", vals: Row[] = [], patch: Row = {}, single = false, ignoreDup = false, lim = Infinity;
    const filters: ((r: Row) => boolean)[] = [];
    const b: any = {
      select() { return b; }, maybeSingle() { single = true; return b; },
      eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return b; },
      lt(c: string, v: string) { filters.push((r) => r[c] < v); return b; },
      or(expr: string) { // only "x.is.null,x.lt.VALUE" is used
        const [a, c] = expr.split(","); const col = a.split(".")[0]; const v = c.split(".lt.")[1];
        filters.push((r) => r[col] == null || r[col] < v); return b;
      },
      order() { return b; }, limit(n: number) { lim = n; return b; },
      insert(v: Row | Row[]) { op = "insert"; vals = [v].flat(); return b; },
      upsert(v: Row | Row[], o?: { ignoreDuplicates?: boolean }) { op = "upsert"; vals = [v].flat(); ignoreDup = !!o?.ignoreDuplicates; return b; },
      update(v: Row) { op = "update"; patch = v; return b; },
      delete() { op = "delete"; return b; },
      then(res: (x: unknown) => unknown, rej: (e: unknown) => unknown) {
        try {
          const rows = tables[t], key = KEYS[t] ?? ["id"];
          const same = (a: Row, c: Row) => key.every((k) => a[k] === c[k]);
          if (op === "select") { const r = rows.filter((x) => filters.every((f) => f(x))).slice(0, lim); return Promise.resolve({ data: single ? (r[0] ?? null) : r, error: null }).then(res, rej); }
          if (op === "insert") { vals.forEach((v) => rows.push({ created_at: new Date().toISOString(), ...v })); }
          if (op === "upsert") for (const v of vals) {
            const i = rows.findIndex((x) => same(x, v));
            if (i < 0) rows.push({ created_at: new Date().toISOString(), ...v }); else if (!ignoreDup) rows[i] = { ...rows[i], ...v };
          }
          if (op === "update") rows.filter((x) => filters.every((f) => f(x))).forEach((x) => Object.assign(x, patch));
          if (op === "delete") tables[t] = rows.filter((x) => !filters.every((f) => f(x)));
          return Promise.resolve({ data: null, error: null }).then(res, rej);
        } catch (e) { return Promise.resolve({ data: null, error: e }).then(res, rej); }
      },
    };
    return b;
  };
  return { from, auth: { getUser: (jwt: string) => Promise.resolve({ data: { user: jwt === "user-jwt" ? { id: "u1" } : null } }) } };
}

// ---------- fake COROS: OAuth server + MCP endpoint ----------
const PORT = 8799, BASE = `http://localhost:${PORT}`;
const codes = new Map<string, string>(); // code -> challenge
let registered: Row | null = null, mcpCalls: string[] = [];
const now = Date.now();
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const accessJwt = "x." + b64url(new TextEncoder().encode(JSON.stringify({ sub: "coros-user-42" }))) + ".y";
const server = Deno.serve({ port: PORT, onListen() {} }, async (req) => {
  const u = new URL(req.url);
  if (u.pathname === "/.well-known/oauth-protected-resource/mcp") return Response.json({ resource: `${BASE}/mcp`, authorization_servers: [`${BASE}/auth`], scopes_supported: ["activities:read"] });
  if (u.pathname === "/.well-known/oauth-authorization-server/auth") return Response.json({
    issuer: `${BASE}/auth`, authorization_endpoint: `${BASE}/auth/authorize`, token_endpoint: `${BASE}/auth/token`,
    registration_endpoint: `${BASE}/auth/register`, token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"],
  });
  if (u.pathname === "/auth/register") { registered = await req.json(); return Response.json({ client_id: "cid-123", token_endpoint_auth_method: "none", ...registered }, { status: 201 }); }
  if (u.pathname === "/auth/authorize") {
    ok(u.searchParams.get("client_id") === "cid-123" && u.searchParams.get("code_challenge_method") === "S256" && u.searchParams.get("resource") === `${BASE}/mcp`);
    const code = "code-" + crypto.randomUUID(); codes.set(code, u.searchParams.get("code_challenge")!);
    return new Response(null, { status: 302, headers: { Location: `${u.searchParams.get("redirect_uri")}?code=${code}&state=${u.searchParams.get("state")}` } });
  }
  if (u.pathname === "/auth/token") {
    const f = new URLSearchParams(await req.text());
    if (f.get("grant_type") === "authorization_code") {
      const ch = codes.get(f.get("code")!);
      const calc = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(f.get("code_verifier")!))));
      if (!ch || ch !== calc || f.get("client_id") !== "cid-123") return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    return Response.json({ access_token: accessJwt, refresh_token: "rt", expires_in: 3600, token_type: "Bearer" });
  }
  if (u.pathname === "/mcp") {
    if (req.headers.get("authorization") !== `Bearer ${accessJwt}`) return new Response("", { status: 401, headers: { "WWW-Authenticate": `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"` } });
    const msg = await req.json(); mcpCalls.push(msg.method);
    if (!msg.id) return new Response(null, { status: 202 });
    let result: unknown = {};
    if (msg.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "coros", version: "1" } };
    if (msg.method === "tools/list") result = { tools: [
      { name: "get_sleep_data", description: "Sleep", inputSchema: { type: "object", properties: {} } },
      { name: "get_activity_detail", description: "Details incl. laps for one activity", inputSchema: { type: "object", properties: { labelId: { type: "string" } } } },
      { name: "query_activity_list", description: "List activity records in a date range", inputSchema: { type: "object", properties: {
        startDay: { type: "integer", description: "Start date, format YYYYMMDD" }, endDay: { type: "integer", description: "End date, format YYYYMMDD" },
        size: { type: "integer", maximum: 50 } } } },
    ] };
    if (msg.method === "tools/call") {
      eq(msg.params.name, "query_activity_list"); ok(String(msg.params.arguments.startDay).length === 8); eq(msg.params.arguments.size, 50);
      result = { content: [{ type: "text", text: JSON.stringify({ count: 2, dataList: [
        { labelId: "L1", name: "Morning Run", sportType: 100, distance: 8420.5, startTime: Math.floor(now / 1000) - 600, totalTime: 2700 },
        { labelId: "L2", name: "Ride", sportType: 200, distance: 30000, startTime: Math.floor(now / 1000) - 300, totalTime: 3600 },
      ] }) }] };
    }
    // Answer as an event stream, with a session id, like a Streamable HTTP server.
    return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`, { headers: { "Content-Type": "text/event-stream", "Mcp-Session-Id": "sess-1" } });
  }
  return new Response("nope", { status: 404 });
});

Deno.test({ name: "COROS via MCP: connect → login → sync → no duplicates → cron", sanitizeResources: false, sanitizeOps: false, async fn() {
  const tables: Record<string, Row[]> = { pets: [{ user_id: "u1", born_at: new Date(now - 3600_000).toISOString(), difficulty: "normal", food: 70 }] };
  __test.setDb(fakeDb(tables));
  const call = (body: unknown, jwt = "user-jwt") => handler(new Request("http://fn.test/functions/v1/watches", { method: "POST", headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }));

  eq((await (await call({ action: "providers" })).json()).coros, true);
  eq((await call({ action: "connect", provider: "coros" }, "bad")).status, 401);

  const connect = await (await call({ action: "connect", provider: "coros" })).json();
  ok(connect.url.startsWith(`${BASE}/auth/authorize?`), connect.url);
  eq(registered!.redirect_uris, ["http://fn.test/functions/v1/watches/callback/coros"]);
  eq(tables.oauth_clients[0].client_id, "cid-123");

  // The user approves on COROS's page; COROS redirects to our callback.
  const authz = await fetch(connect.url, { redirect: "manual" });
  const cb = authz.headers.get("location")!; await authz.body?.cancel();
  const back = await handler(new Request(cb));
  eq(back.status, 302);
  eq(back.headers.get("location"), "https://runagotchi.netlify.app/?watch=coros&status=ok");
  eq(tables.watch_tokens[0].provider_user_id, "coros-user-42");
  eq(tables.watch_links.length, 1);
  tables.watch_links[0].connected_at = new Date(now - 3600_000).toISOString(); // connected an hour ago

  const sync = await (await call({ action: "sync", provider: "coros" })).json();
  eq(sync, { imported: 1 });
  eq(tables.runs.length, 1);
  eq({ km: tables.runs[0].km, source: tables.runs[0].source, ext: tables.runs[0].external_id, dur: tables.runs[0].dur_min }, { km: 8.42, source: "coros", ext: "L1", dur: 45 });
  ok(tables.pets[0].food > 99, "pet was fed: " + tables.pets[0].food);
  ok(mcpCalls.slice(0, 4).join(",") === "initialize,notifications/initialized,tools/list,tools/call", mcpCalls.join(","));

  await call({ action: "sync", provider: "coros" });
  eq(tables.runs.length, 1); // same run again is ignored

  const diag = await (await call({ action: "diagnose", provider: "coros" })).json();
  eq(diag.picked, "query_activity_list"); eq(diag.found.length, 2);

  tables.watch_links[0].last_sync_at = new Date(now - 3600_000).toISOString();
  eq((await handler(new Request("http://fn.test/functions/v1/watches/cron?key=wrong", { method: "POST" }))).status, 403);
  const cron = await (await handler(new Request("http://fn.test/functions/v1/watches/cron?key=k", { method: "POST" }))).json();
  eq({ users: cron.users, failed: cron.failed }, { users: 1, failed: 0 });

  // Someone else can't take over the same COROS account.
  const c2 = await (await handler(new Request("http://fn.test/functions/v1/watches", { method: "POST", headers: { Authorization: "Bearer user-jwt" }, body: JSON.stringify({ action: "connect", provider: "coros" }) }))).json();
  tables.watch_tokens[0].user_id = "someone-else";
  const a2 = await fetch(c2.url, { redirect: "manual" }); const cb2 = a2.headers.get("location")!; await a2.body?.cancel();
  eq((await handler(new Request(cb2))).headers.get("location"), "https://runagotchi.netlify.app/?watch=coros&status=error&reason=already_linked");

  eq((await call({ action: "disconnect", provider: "coros" })).status, 200);
  eq(tables.watch_links.length, 0);
  await server.shutdown();
} });

Deno.test("activity extraction handles common shapes", () => {
  const t = Math.floor(Date.UTC(2026, 10, 17, 7) / 1000);
  eq(extractActivities({ structuredContent: { activities: [{ activityId: 9, sportName: "Trail Run", distanceKm: 12.3, startTime: "2026-11-17T07:00:00Z", duration: 4000 }] } }),
    [{ externalId: "9", startMs: Date.UTC(2026, 10, 17, 7), km: 12.3, durMin: 4000 / 60, isRun: true }]);
  eq(extractActivities({ content: [{ type: "text", text: "Here you go: " + JSON.stringify([{ id: "a", type: "Cycling", distance: 20000, start_time: t }]) }] })[0].isRun, false);
  eq(extractActivities({ content: [{ type: "text", text: "No activities found." }] }), []);
  eq(extractActivities({ content: [{ type: "text", text: JSON.stringify({ data: [{ labelId: "x", sportType: 101, distance: 5000, date: 20261117 }] }) }] })[0].km, 5);
});

Deno.test("tool choice and arguments", () => {
  const tools = [{ name: "create_workout" }, { name: "get_activity_fit_file" }, { name: "list_activities", inputSchema: { properties: {
    start_date: { type: "string", description: "YYYY-MM-DD" }, end_date: { type: "string", format: "date-time" }, limit: { type: "integer" } } } }];
  const t = pickActivityTool(tools); eq(t.name, "list_activities");
  eq(activityArgs(t, Date.UTC(2026, 10, 1), Date.UTC(2026, 10, 17)), { start_date: "2026-11-01", end_date: "2026-11-17T00:00:00.000Z", limit: 100 });
  eq(pickActivityTool([{ name: "get_sleep" }]), null);
  eq(parseSse("event: message\ndata: {\"id\":3,\"result\":1}\n\n", 3).result, 1);
  eq(jwtSubject("a.eyJzdWIiOiJ4In0.b"), "x");
});
