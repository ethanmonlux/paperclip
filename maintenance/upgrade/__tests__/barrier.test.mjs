import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { assessHealth, BarrierError, createApiClient, runUnderMaintenanceBarrier, waitForExactHealth } from "../lib/barrier.mjs";

const OLD = "f".repeat(40);
const NEW = "9".repeat(40);
const TOKEN = "Bearer test-board-token";

// A fake instance that mirrors the shapes of /api/health and
// /api/instance/task-drain, including redacted health for anonymous callers.
function fakeInstance({ commit = OLD, persisted = ["present", "none", "none", "none"], activeRuns = 0, drainHeld = false } = {}) {
  const state = { commit, drain: drainHeld ? { ownerId: "someone-else", startedAt: "s0" } : null, calls: [], persisted: [...persisted], activeRuns };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    state.calls.push(`${req.method} ${url.pathname}${url.search}`);
    const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const authed = req.headers.authorization === TOKEN;
    if (url.pathname === "/api/health") {
      return send(200, authed
        ? { status: "ok", serverVersion: "2026.1030.0", commit: state.commit, serverInfo: { git: { fullSha: state.commit } }, startupRecovery: { phase: "ready" } }
        : { status: "ok", deploymentMode: "authenticated", commit: state.commit });
    }
    if (url.pathname !== "/api/instance/task-drain") return send(404, {});
    if (!authed) return send(401, { error: "unauthorized" });
    if (req.method === "POST") {
      if (state.drain) return send(409, { error: "Another task drain is already active" });
      state.drain = { ownerId: "owner-1", startedAt: "s1", expiresAt: "e1" };
      return send(200, state.drain);
    }
    if (req.method === "DELETE") {
      if (state.drain?.ownerId !== url.searchParams.get("ownerId")) return send(409, { error: "Task drain ownership changed" });
      state.drain = null;
      return send(200, { wasActive: true });
    }
    const base = { ...(state.drain ?? {}), draining: Boolean(state.drain), activeRuns: state.activeRuns, pendingWakes: 0 };
    if (url.searchParams.get("idleSleepSafety") === "1") base.idleSleepSafety = { version: 1, backgroundWork: state.persisted.shift() ?? "none" };
    return send(200, base);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const request = createApiClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, authorization: TOKEN });
    resolve({ state, request, close: () => new Promise((r) => server.close(r)), baseUrl: `http://127.0.0.1:${server.address().port}` });
  }));
}

const fast = { pollMs: 1, sleep: async () => {}, quietReads: 3 };

test("redacted public health never satisfies exact-commit verification", async () => {
  const instance = await fakeInstance();
  try {
    const anonymous = createApiClient({ baseUrl: instance.baseUrl, authorization: "Bearer wrong" });
    assert.deepEqual(assessHealth(await anonymous("GET", "/api/health"), OLD), { ok: false, reason: "unauthenticated-or-redacted" });
    assert.equal(assessHealth(await instance.request("GET", "/api/health"), OLD).ok, true);
    assert.equal(assessHealth(await instance.request("GET", "/api/health"), NEW).reason, `commit-${OLD}`);
    await assert.rejects(waitForExactHealth(instance.request, NEW, { timeoutMs: 5, pollMs: 1, sleep: async () => {} }), (error) => error.code === "health_not_exact");
  } finally { await instance.close(); }
});

test("activates only after consecutive owned quiet reads with a persisted-work inventory", async () => {
  const instance = await fakeInstance();
  try {
    let activatedWith;
    const outcome = await runUnderMaintenanceBarrier(instance.request, async ({ ownerId }) => {
      activatedWith = ownerId;
      instance.state.commit = NEW;
      return "installed";
    }, { expectedCurrentCommit: OLD, ...fast });
    assert.equal(activatedWith, "owner-1");
    assert.equal(outcome.result, "installed");
    assert.equal(outcome.release.released, true);
    const quietReads = instance.state.calls.filter((call) => call.includes("idleSleepSafety=1"));
    assert.equal(quietReads.length, 4, "the first read reported persisted work, then three quiet reads");
    assert.equal(instance.state.drain, null);
  } finally { await instance.close(); }
});

test("zero in-memory runs alone is not quiescence; the barrier times out and is released", async () => {
  const instance = await fakeInstance({ persisted: Array(50).fill("unknown") });
  try {
    let ticks = 0;
    await assert.rejects(
      runUnderMaintenanceBarrier(instance.request, async () => assert.fail("must not activate"), {
        expectedCurrentCommit: OLD, ...fast, quiescenceTimeoutMs: 10, now: () => (ticks += 3),
      }),
      (error) => error instanceof BarrierError && error.code === "not_quiescent" && error.details.last.reason === "persisted-work:unknown",
    );
    assert.equal(instance.state.drain, null, "owned barrier released after failure");
    assert.ok(instance.state.calls.includes("DELETE /api/instance/task-drain?ownerId=owner-1"));
  } finally { await instance.close(); }
});

test("activation failure releases the owned barrier and rethrows the original error", async () => {
  const instance = await fakeInstance({ persisted: [] });
  try {
    await assert.rejects(
      runUnderMaintenanceBarrier(instance.request, async () => { throw new Error("install failed"); }, { expectedCurrentCommit: OLD, ...fast }),
      /install failed/,
    );
    assert.equal(instance.state.drain, null);
  } finally { await instance.close(); }
});

test("a restart that drops the in-memory drain is reported as already released", async () => {
  const instance = await fakeInstance({ persisted: [] });
  try {
    const outcome = await runUnderMaintenanceBarrier(instance.request, async () => {
      instance.state.drain = null; // service restarted into the new payload
      instance.state.commit = NEW;
    }, { expectedCurrentCommit: OLD, ...fast });
    assert.deepEqual(outcome.release, { released: true, wasActive: false, note: "drain-already-gone" });
  } finally { await instance.close(); }
});

test("refuses to start against the wrong running commit or a barrier held by someone else", async () => {
  const wrong = await fakeInstance({ commit: NEW });
  try {
    await assert.rejects(runUnderMaintenanceBarrier(wrong.request, async () => {}, { expectedCurrentCommit: OLD, ...fast }), (error) => error.code === "preflight_health");
    assert.ok(!wrong.state.calls.some((call) => call.startsWith("POST")));
  } finally { await wrong.close(); }
  const held = await fakeInstance({ drainHeld: true });
  try {
    await assert.rejects(runUnderMaintenanceBarrier(held.request, async () => {}, { expectedCurrentCommit: OLD, ...fast }), (error) => error.code === "barrier_held");
    assert.equal(held.state.drain.ownerId, "someone-else", "another owner's drain is untouched");
  } finally { await held.close(); }
});

test("in-memory runs keep the instance non-quiescent", async () => {
  const instance = await fakeInstance({ activeRuns: 1, persisted: Array(50).fill("none") });
  try {
    let ticks = 0;
    await assert.rejects(
      runUnderMaintenanceBarrier(instance.request, async () => assert.fail("must not activate"), { expectedCurrentCommit: OLD, ...fast, quiescenceTimeoutMs: 10, now: () => (ticks += 3) }),
      (error) => error.code === "not_quiescent" && error.details.last.reason === "in-memory-work:1/0",
    );
  } finally { await instance.close(); }
});

test("requires a credential", () => {
  assert.throws(() => createApiClient({ baseUrl: "http://127.0.0.1:1" }), (error) => error.code === "credential_missing");
});
