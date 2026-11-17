// deno test --allow-env --allow-net watches_test.ts   (with RUNAGOTCHI_TEST=1)
import { deepStrictEqual as assertEquals, ok as assert } from "node:assert";
import { parseGarminPush, suuntoWorkoutToActivity, simulate, pkceChallenge, handler } from "./index.ts";

Deno.test("garmin push: runs kept, rides flagged, grouped by user", () => {
  const { byUser, deregistered } = parseGarminPush({
    activities: [
      { userId: "g1", summaryId: "s1", activityType: "RUNNING", startTimeInSeconds: 1794900000, durationInSeconds: 1800, distanceInMeters: 5230 },
      { userId: "g1", summaryId: "s2", activityType: "CYCLING", startTimeInSeconds: 1794910000, durationInSeconds: 3600, distanceInMeters: 30000 },
      { userId: "g2", summaryId: "s3", activityType: "TRAIL_RUNNING", startTimeInSeconds: 1794920000, distanceInMeters: 10000 },
    ],
    deregistrations: [{ userId: "g9" }],
  });
  assertEquals(byUser.g1.length, 2);
  assertEquals(byUser.g1[0], { externalId: "s1", startMs: 1794900000000, km: 5.23, durMin: 30, isRun: true });
  assertEquals(byUser.g1[1].isRun, false);
  assertEquals(byUser.g2[0].isRun, true);
  assertEquals(deregistered, ["g9"]);
});

Deno.test("suunto workout mapping", () => {
  const a = suuntoWorkoutToActivity({ workoutKey: "w1", activityId: 3, startTime: 1794900000000, totalTime: 2400, totalDistance: 8000 })!;
  assertEquals(a, { externalId: "w1", startMs: 1794900000000, km: 8, durMin: 40, isRun: true });
  assertEquals(suuntoWorkoutToActivity({ workoutKey: "w2", activityId: 2, startTime: 1, totalDistance: 1 })!.isRun, false);
  assertEquals(suuntoWorkoutToActivity({}), null);
});

Deno.test("pet simulation matches the app", () => {
  const H = 3.6e6, born = 0;
  const s1 = simulate(born, "normal", [], 24 * H); // 70 food - 24h * (200/168)
  assert(Math.abs(s1.f - (70 - 24 * 200 / 168)) < 1e-9);
  const s2 = simulate(born, "normal", [{ date: 1 * H, km: 5 }], 1 * H);
  assertEquals(Math.round(s2.f), 100);
  const s3 = simulate(born, "normal", [], 200 * H); // empty after ~59h, dead 72h later
  assertEquals(s3.dead, true);
  const s4 = simulate(born, "normal", [{ date: 199 * H, km: 6 }], 199 * H); // revived
  assertEquals(s4.dead, false); assertEquals(s4.f, 60);
});

Deno.test("PKCE challenge = base64url(sha256(verifier))", async () => {
  assertEquals(await pkceChallenge("dBjftJeZ4CVP-mJ92K-cz2pd6GRkwzbtbRjjtN8sAhs"), "ZdyYAF_FCMLs9Fcl68oTtE02hePOYOalGf_chK1c4Uk");
});

Deno.test("webhook rejects a wrong key, unknown routes 404", async () => {
  const r1 = await handler(new Request("http://x/functions/v1/watches/webhook/garmin?key=nope", { method: "POST", body: "{}" }));
  assertEquals(r1.status, 403);
  const r2 = await handler(new Request("http://x/functions/v1/watches/whatever/zzz"));
  assertEquals(r2.status, 404);
  const r4 = await handler(new Request("http://x/functions/v1/watches/status"));
  assertEquals(r4.status, 200); assertEquals((await r4.json()).ok, true);
  const r3 = await handler(new Request("http://x/functions/v1/watches", { method: "OPTIONS" }));
  assertEquals(r3.status, 200);
});
