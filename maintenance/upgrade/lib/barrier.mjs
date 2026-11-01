import http from "node:http";
import https from "node:https";

const DRAIN_PATH = "/api/instance/task-drain";

export class BarrierError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BarrierError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Direct request on a fresh Agent. Global fetch and the global agents honour
 * NODE_USE_ENV_PROXY, which would send the instance credential through an
 * egress proxy; the barrier must only ever talk to the instance itself.
 */
export function directFetch(url, { method = "GET", headers = {}, body, signal } = {}) {
  const target = new URL(url);
  const transport = target.protocol === "https:" ? https : target.protocol === "http:" ? http : null;
  if (!transport) return Promise.reject(new BarrierError("unsupported_url", `Unsupported instance URL protocol ${target.protocol}`));
  const agent = new transport.Agent({ keepAlive: false });
  return new Promise((resolve, reject) => {
    const req = transport.request(target, { method, headers, agent, signal }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode, json: async () => JSON.parse(text) });
      });
    });
    req.on("error", reject);
    req.on("close", () => agent.destroy());
    req.end(body);
  });
}

/** Minimal authenticated JSON client. The credential is never logged or returned. */
export function createApiClient({ baseUrl, authorization, fetchImpl = directFetch, timeoutMs = 10_000 }) {
  if (!authorization) throw new BarrierError("credential_missing", "An authenticated instance-admin credential is required.");
  return async function request(method, path, body) {
    const response = await fetchImpl(new URL(path, baseUrl), {
      method,
      headers: { Authorization: authorization, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    let json = null;
    try { json = await response.json(); } catch { json = null; }
    return { status: response.status, json };
  };
}

/**
 * Authenticated exact-commit health. Public health always carries `commit`, but
 * only an authenticated board/agent view includes serverVersion, serverInfo and
 * startupRecovery. Require all of them so a redacted or stale answer never passes.
 */
export function assessHealth(response, expectedCommit) {
  const body = response?.json;
  if (response?.status !== 200 || !body) return { ok: false, reason: `http-${response?.status ?? "none"}` };
  if (body.status !== "ok") return { ok: false, reason: `status-${body.status}` };
  if (typeof body.serverVersion !== "string" || !body.serverInfo) return { ok: false, reason: "unauthenticated-or-redacted" };
  if (body.commit !== expectedCommit) return { ok: false, reason: `commit-${body.commit ?? "none"}` };
  if (body.serverInfo?.git?.fullSha !== undefined && body.serverInfo.git.fullSha !== expectedCommit) return { ok: false, reason: "serverInfo-commit-mismatch" };
  if (body.startupRecovery?.phase !== "ready") return { ok: false, reason: `startup-${body.startupRecovery?.phase ?? "unknown"}` };
  return { ok: true, serverVersion: body.serverVersion, commit: body.commit };
}

export async function waitForExactHealth(request, expectedCommit, { timeoutMs = 120_000, pollMs = 1_000, sleep = defaultSleep, now = Date.now } = {}) {
  const deadline = now() + timeoutMs;
  let last = null;
  do {
    try {
      last = assessHealth(await request("GET", "/api/health"), expectedCommit);
      if (last.ok) return last;
    } catch (error) {
      last = { ok: false, reason: error?.name === "TimeoutError" ? "timeout" : "unreachable" };
    }
    if (now() >= deadline) break;
    await sleep(pollMs);
  } while (now() < deadline);
  throw new BarrierError("health_not_exact", `Service did not report authenticated ready health at ${expectedCommit}.`, { last });
}

/**
 * Quiescence needs the owned drain, no in-memory runs or wakes, and a positive
 * persisted-work inventory. A count of zero processes alone is insufficient.
 * `upgradeSafety` is the narrower upgrade inventory (not provided by servers
 * at the time of writing); `idleSleepSafety` is the stricter existing one.
 */
export function assessQuiescence(status, ownerId) {
  if (!status || status.ownerId !== ownerId || status.draining !== true) return { quiet: false, reason: "barrier-not-owned" };
  if (status.activeRuns !== 0 || status.pendingWakes !== 0) return { quiet: false, reason: `in-memory-work:${status.activeRuns}/${status.pendingWakes}` };
  const inventory = status.upgradeSafety?.inFlight ?? status.idleSleepSafety?.backgroundWork;
  if (inventory === "none") return { quiet: true, startedAt: status.startedAt };
  return { quiet: false, reason: `persisted-work:${inventory ?? "unknown"}` };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Hold the authenticated task-drain barrier, prove quiescence, run `activate`,
 * and always release the owned barrier when activation fails recoverably. A
 * service restart drops the in-memory drain; release then confirms it is gone
 * rather than reporting a false failure.
 */
export async function runUnderMaintenanceBarrier(request, activate, {
  expectedCurrentCommit,
  ttlMs = 15 * 60_000,
  quietReads = 3,
  pollMs = 2_000,
  quiescenceTimeoutMs = 10 * 60_000,
  sleep = defaultSleep,
  now = Date.now,
  log = () => {},
} = {}) {
  if (!expectedCurrentCommit) throw new BarrierError("commit_missing", "expectedCurrentCommit is required.");
  const before = assessHealth(await request("GET", "/api/health"), expectedCurrentCommit);
  if (!before.ok) throw new BarrierError("preflight_health", `Running service is not the expected ${expectedCurrentCommit}: ${before.reason}.`, { before });

  const acquired = await request("POST", DRAIN_PATH, { purpose: "idle", ttlMs });
  if (acquired.status === 409) throw new BarrierError("barrier_held", "Another task drain is already active.");
  const ownerId = acquired.json?.ownerId;
  if (acquired.status !== 200 || typeof ownerId !== "string" || !ownerId) {
    throw new BarrierError("barrier_acquire_failed", `Task drain was not acquired (HTTP ${acquired.status}).`);
  }
  log({ event: "barrier_acquired", ownerId, expiresAt: acquired.json.expiresAt ?? null });

  const release = async () => {
    const response = await request("DELETE", `${DRAIN_PATH}?ownerId=${encodeURIComponent(ownerId)}`);
    if (response.status === 200) return { released: true, wasActive: response.json?.wasActive ?? null };
    const status = await request("GET", DRAIN_PATH);
    if (status.status === 200 && status.json?.draining === false) return { released: true, wasActive: false, note: "drain-already-gone" };
    throw new BarrierError("barrier_release_failed", `Owned task drain could not be released (HTTP ${response.status}).`, { ownerId });
  };

  let result;
  try {
    const deadline = now() + quiescenceTimeoutMs;
    let streak = 0;
    let startedAt = null;
    let last = null;
    while (streak < quietReads) {
      const status = await request("GET", `${DRAIN_PATH}?idleSleepSafety=1&ownerId=${encodeURIComponent(ownerId)}`);
      last = status.status === 200 ? assessQuiescence(status.json, ownerId) : { quiet: false, reason: `http-${status.status}` };
      if (last.quiet && (startedAt === null || last.startedAt === startedAt)) { startedAt = last.startedAt; streak += 1; }
      else { streak = 0; startedAt = null; }
      if (last.reason === "barrier-not-owned") throw new BarrierError("barrier_lost", "The owned task drain disappeared or changed owner.", { last });
      if (streak >= quietReads) break;
      if (now() >= deadline) throw new BarrierError("not_quiescent", "Instance did not become quiescent under the owned barrier.", { last });
      await sleep(pollMs);
    }
    log({ event: "quiescent", ownerId, reads: streak });
    result = await activate({ ownerId, request });
    log({ event: "activated", ownerId });
  } catch (error) {
    let releaseOutcome;
    try { releaseOutcome = await release(); } catch (releaseError) {
      throw new BarrierError("barrier_release_failed", "Activation failed and the owned barrier could not be released.", { cause: error, releaseError, ownerId });
    }
    log({ event: "barrier_released_after_failure", ownerId, ...releaseOutcome });
    throw error;
  }
  return { ownerId, result, release: await release() };
}
