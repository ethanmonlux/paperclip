import { describe, expect, it, vi } from "vitest";
import type { IssueWaitTarget } from "@paperclipai/shared";
import {
  CI_NO_START_DEADLINE_MS,
  classifyCiWait,
  classifyPullRequestMergeableWait,
  evaluateServerWait,
  prepareWaitRecordMonitor,
  readGitHubWaitSnapshot,
  type GitHubWaitSnapshot,
} from "./wait-records.js";

const now = new Date("2026-11-09T12:00:00.000Z");
const sha = "2ec2c3622a902faef95f2c689f2ce4fe7014fb05";
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
const target = { repo: "ethanmonlux/paperclip", sha, pullNumber: 25, pushedAt: minutesAgo(40) };
const cleanPr = { state: "open", merged: false, mergeable: true, mergeableState: "clean", headSha: sha };

function snapshot(overrides: Partial<GitHubWaitSnapshot> = {}): GitHubWaitSnapshot {
  return { checkRuns: [], checkRunsComplete: true, workflowRuns: [], pullRequest: cleanPr, ...overrides };
}

describe("ci wait record (FAC-840 incident replays)", () => {
  it("STA-136 no CI: nothing started 40 min after push expires as no_start", () => {
    const result = classifyCiWait({ target, snapshot: snapshot(), now });
    expect(result.action).toBe("expire");
    expect(result.observation.state).toBe("no_start");
    expect(result.observation.detail).toContain("re-trigger once");
    expect(result.observation.detail).toContain("no CI applies");
  });

  it("STA-136 no CI: within 10 min of the push keeps waiting until the no-start deadline", () => {
    const pushedAt = minutesAgo(9);
    const result = classifyCiWait({ target: { ...target, pushedAt }, snapshot: snapshot(), now });
    expect(result).toMatchObject({ action: "keep_waiting", notice: false, observation: { state: "not_started" } });
    if (result.action !== "keep_waiting") throw new Error("unreachable");
    expect(result.nextCheckAt.getTime()).toBeLessThanOrEqual(Date.parse(pushedAt) + CI_NO_START_DEADLINE_MS);
  });

  it("STA-136 conflicting PR: a dirty PR asks for a base update before missing CI is classified", () => {
    const result = classifyCiWait({
      target,
      snapshot: snapshot({ pullRequest: { ...cleanPr, mergeable: false, mergeableState: "dirty" } }),
      now,
    });
    expect(result.action).toBe("wake");
    expect(result.observation.state).toBe("base_update_required");
  });

  it("slow CI: a run in progress for hours keeps waiting even after timeoutAt passed", () => {
    const result = classifyCiWait({
      target: { ...target, pushedAt: minutesAgo(180) },
      timeoutAt: minutesAgo(120),
      snapshot: snapshot({
        checkRuns: [{ name: "server", status: "in_progress", conclusion: null, checkSuiteId: 7 }],
        workflowRuns: [{ id: 1, name: "CI", status: "in_progress", conclusion: null, checkSuiteId: 7, createdAt: minutesAgo(179) }],
      }),
      now,
    });
    expect(result).toMatchObject({ action: "keep_waiting", notice: false, observation: { state: "started" } });
  });

  it("slow CI: queued over 30 min with nothing in progress reports once and keeps waiting", () => {
    const queued = snapshot({
      workflowRuns: [{ id: 1, name: "CI", status: "queued", conclusion: null, checkSuiteId: 7, createdAt: minutesAgo(45) }],
    });
    const first = classifyCiWait({ target, snapshot: queued, now });
    expect(first).toMatchObject({ action: "keep_waiting", notice: true, observation: { state: "queued_long" } });
    expect(first.observation.detail).toContain("does not re-trigger");
    const second = classifyCiWait({ target, snapshot: queued, now, previous: first.observation });
    expect(second).toMatchObject({ action: "keep_waiting", notice: false, observation: { state: "queued_long" } });
  });

  it("slow CI: a run queued recently on an old push is not reported as a long queue", () => {
    const result = classifyCiWait({
      target: { ...target, pushedAt: minutesAgo(90) },
      snapshot: snapshot({
        workflowRuns: [{ id: 1, name: "CI", status: "queued", conclusion: null, checkSuiteId: 7, createdAt: minutesAgo(4) }],
      }),
      now,
    });
    expect(result).toMatchObject({ action: "keep_waiting", notice: false, observation: { state: "started" } });
  });

  it("surfaces startup_failure, action_required and a zero-job workflow run now", () => {
    for (const run of [
      { status: "completed", conclusion: "startup_failure", checkSuiteId: 9 },
      { status: "action_required", conclusion: null, checkSuiteId: 9 },
      { status: "completed", conclusion: "failure", checkSuiteId: 9 },
    ]) {
      const result = classifyCiWait({
        target,
        snapshot: snapshot({
          checkRuns: [{ name: "other", status: "completed", conclusion: "success", checkSuiteId: 1 }],
          workflowRuns: [{ id: 2, name: "Release", createdAt: minutesAgo(5), ...run }],
        }),
        now,
      });
      expect(result).toMatchObject({ action: "wake", observation: { state: "startup_failure" } });
    }
  });

  it("does not call a workflow zero-job when check runs were truncated", () => {
    const result = classifyCiWait({
      target,
      snapshot: snapshot({
        checkRunsComplete: false,
        checkRuns: [{ name: "a", status: "completed", conclusion: "success", checkSuiteId: 1 }],
        workflowRuns: [{ id: 2, name: "CI", status: "completed", conclusion: "success", checkSuiteId: 9, createdAt: minutesAgo(5) }],
      }),
      now,
    });
    expect(result.observation.state).toBe("passed");
  });

  it("wakes with passed or failed once every run completed", () => {
    const suite = (conclusion: string) => snapshot({
      checkRuns: [{ name: "server", status: "completed", conclusion, checkSuiteId: 7 }],
      workflowRuns: [{ id: 1, name: "CI", status: "completed", conclusion, checkSuiteId: 7, createdAt: minutesAgo(30) }],
    });
    expect(classifyCiWait({ target, snapshot: suite("success"), now })).toMatchObject({ action: "wake", observation: { state: "passed" } });
    const failed = classifyCiWait({ target, snapshot: suite("failure"), now });
    expect(failed).toMatchObject({ action: "wake", observation: { state: "failed" } });
    expect(failed.observation.detail).toContain("server");
  });

  it("wakes when the PR head moved past the recorded SHA", () => {
    const result = classifyCiWait({ target, snapshot: snapshot({ pullRequest: { ...cleanPr, headSha: "f".repeat(40) } }), now });
    expect(result).toMatchObject({ action: "wake", observation: { state: "superseded" } });
  });
});

describe("pr_mergeable wait record", () => {
  const prTarget = { repo: "ethanmonlux/paperclip", pullNumber: 25 };
  it("resolves when mergeable or closed", () => {
    expect(classifyPullRequestMergeableWait({ target: prTarget, snapshot: snapshot(), now }).action).toBe("wake");
    expect(classifyPullRequestMergeableWait({
      target: prTarget, snapshot: snapshot({ pullRequest: { ...cleanPr, state: "closed", merged: true } }), now,
    }).observation.state).toBe("closed");
  });

  it("keeps waiting on a conflict or pending mergeability until the deadline, then expires", () => {
    const dirty = snapshot({ pullRequest: { ...cleanPr, mergeable: false, mergeableState: "dirty" } });
    expect(classifyPullRequestMergeableWait({ target: prTarget, snapshot: dirty, now, timeoutAt: minutesAgo(-60) }))
      .toMatchObject({ action: "keep_waiting", observation: { state: "conflicting" } });
    expect(classifyPullRequestMergeableWait({ target: prTarget, snapshot: dirty, now, timeoutAt: minutesAgo(1) }))
      .toMatchObject({ action: "expire", observation: { state: "conflicting" } });
    const computing = snapshot({ pullRequest: { ...cleanPr, mergeable: null, mergeableState: "unknown" } });
    expect(classifyPullRequestMergeableWait({ target: prTarget, snapshot: computing, now }).observation.state).toBe("pending_mergeability");
  });
});

describe("wait record validation", () => {
  const base = { nextCheckAt: minutesAgo(-2), timeoutAt: null };
  it("requires the exact SHA for ci and stamps pushedAt", () => {
    expect(() => prepareWaitRecordMonitor({ ...base, kind: "ci", target: { repo: "o/r" } }, now)).toThrow(/target.sha/);
    const ciTarget: IssueWaitTarget = { repo: "o/r", sha };
    const prepared = prepareWaitRecordMonitor({ ...base, kind: "ci", target: ciTarget }, now);
    expect(prepared.target?.pushedAt).toBe(now.toISOString());
  });

  it("requires a PR for pr_mergeable and gives it a default deadline", () => {
    expect(() => prepareWaitRecordMonitor({ ...base, kind: "pr_mergeable", target: { repo: "o/r" } }, now)).toThrow(/pullNumber/);
    const prepared = prepareWaitRecordMonitor({ ...base, kind: "pr_mergeable", target: { repo: "o/r", pullNumber: 3 } }, now);
    expect(Date.parse(prepared.timeoutAt!)).toBeGreaterThan(Date.parse(base.nextCheckAt));
  });

  it("rejects a target on an external monitor and leaves ordinary monitors unchanged", () => {
    expect(() => prepareWaitRecordMonitor({ ...base, kind: "external_service", target: { repo: "o/r" } }, now)).toThrow();
    const plain = { ...base, kind: null, target: null };
    expect(prepareWaitRecordMonitor(plain, now)).toBe(plain);
  });
});

describe("server wait evaluation through GitHub", () => {
  const monitor = { kind: "ci" as const, target, timeoutAt: null };
  function fakeGitHub(routes: Record<string, unknown>) {
    return vi.fn(async (url: string) => {
      const path = url.replace("https://api.github.com/repos/ethanmonlux/paperclip", "");
      const key = Object.keys(routes).find(prefix => path.startsWith(prefix));
      return key ? new Response(JSON.stringify(routes[key])) : new Response("{}", { status: 404 });
    });
  }

  it("reads exact-SHA check runs, workflow runs and the PR", async () => {
    const fetchImpl = fakeGitHub({
      "/pulls/25": { state: "open", merged: false, mergeable: true, mergeable_state: "clean", head: { sha } },
      [`/commits/${sha}/check-runs`]: { total_count: 1, check_runs: [{ name: "server", status: "queued", conclusion: null, check_suite: { id: 7 } }] },
      [`/actions/runs?head_sha=${sha}`]: { workflow_runs: [{ id: 1, name: "CI", status: "queued", conclusion: null, check_suite_id: 7, created_at: minutesAgo(3) }] },
    });
    const read = await readGitHubWaitSnapshot({ kind: "ci", target, token: "t", fetchImpl });
    expect(read.checkRuns).toEqual([{ name: "server", status: "queued", conclusion: null, checkSuiteId: 7 }]);
    expect(read.workflowRuns[0]).toMatchObject({ status: "queued", checkSuiteId: 7 });
    expect(read.pullRequest).toMatchObject({ mergeableState: "clean", headSha: sha });
    const result = await evaluateServerWait({ monitor, now, resolveToken: async () => "t", fetchImpl });
    expect(result).toMatchObject({ action: "keep_waiting", observation: { state: "started" } });
  });

  it("falls back to an owner wake when GitHub or its credential is unavailable", async () => {
    expect(await evaluateServerWait({ monitor, now, resolveToken: async () => null }))
      .toMatchObject({ action: "fallback", observation: { state: "unobservable" } });
    const result = await evaluateServerWait({ monitor, now, resolveToken: async () => "t", fetchImpl: fakeGitHub({}) });
    expect(result).toMatchObject({ action: "fallback", observation: { state: "unobservable" } });
    expect(result.observation.detail).toContain("HTTP 404");
  });
});
