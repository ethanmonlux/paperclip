import { describe, expect, it, vi } from "vitest";
import type { MergeGateGitHub } from "./github.js";
import type { MergeGateCheck, MergeReviewAttestation } from "./policy.js";
import { evaluateAndMerge, reportRedMain, type GateIssue, type MergeGateDependencies } from "./service.js";

const HEAD = "a".repeat(40);
const REVIEWED = "b".repeat(40);
const BASE = "c".repeat(40);
const COMPANY = "company-1";

const ok = (name: string): MergeGateCheck => ({ kind: "check_run", name, status: "completed", conclusion: "success" });

function issue(overrides: Partial<GateIssue> & { id: string }): GateIssue {
  return {
    companyId: COMPANY, identifier: overrides.id.toUpperCase(), title: overrides.id, status: "in_review", priority: "high",
    projectId: "project-1", parentId: null, assigneeAgentId: null, createdByAgentId: null,
    originKind: "manual", originId: null, ...overrides,
  };
}

function fakeGitHub(overrides: Partial<{ baseChecks: MergeGateCheck[]; headChecks: MergeGateCheck[]; behindBy: number; headSha: string }> = {}) {
  const headSha = overrides.headSha ?? HEAD;
  const merge = vi.fn(async () => ({ merged: true, sha: "d".repeat(40), message: "Pull Request successfully merged" }));
  const github: MergeGateGitHub = {
    pullRequest: async () => ({ state: "open", merged: false, draft: false, headSha, headRef: "sta-1", baseRef: "main", mergeable: true, mergeableState: "clean" }),
    branchHead: async () => BASE,
    compare: async (from, to) => {
      if (from === "main") return { status: "ahead", aheadBy: 3, behindBy: overrides.behindBy ?? 0, totalCommits: 3, commits: [], files: [], complete: true };
      if (from === REVIEWED && to === HEAD) {
        return { status: "ahead", aheadBy: 3, behindBy: 0, totalCommits: 3, complete: true, files: [],
          commits: [{ sha: "m1", parentCount: 1 }, { sha: "m2", parentCount: 1 }, { sha: "merge", parentCount: 2 }] };
      }
      if (from === REVIEWED && to === BASE) {
        return { status: "ahead", aheadBy: 2, behindBy: 0, totalCommits: 2, complete: true, files: [],
          commits: [{ sha: "m1", parentCount: 1 }, { sha: "m2", parentCount: 1 }] };
      }
      // compare(base...reviewed): the PR's own diff at review time.
      return { status: "diverged", aheadBy: 1, behindBy: 2, totalCommits: 1, complete: true, commits: [],
        files: [{ filename: "account-web/app/page.tsx", status: "modified", blobSha: "x1", patch: "@@ -1 +1 @@\n-a\n+b" }] };
    },
    pullRequestFiles: async () => [{ filename: "account-web/app/page.tsx", status: "modified", blobSha: "x2", patch: "@@ -4 +4 @@\n-a\n+b" }],
    checks: async sha => ({ complete: true, checks: sha === BASE ? (overrides.baseChecks ?? [ok("verify")]) : (overrides.headChecks ?? [ok("verify"), ok("shell")]) }),
    merge,
  };
  return { github, merge };
}

function review(overrides: Partial<MergeReviewAttestation> = {}): MergeReviewAttestation {
  return {
    reviewIssueId: "review", reviewIssueIdentifier: "STA-REVIEW", reviewIssueStatus: "done", reviewerAgentId: "codex-reviewer",
    reviewerAdapterType: "codex_local", writtenByReviewer: true, scope: "full", reviewedSha: HEAD,
    pullRequest: "ethanmonlux/facette#704", p0: 0, p1: 0, p2: [], ...overrides,
  };
}

function harness(input: { github: MergeGateGitHub; reviews?: MergeReviewAttestation[]; issues?: GateIssue[] }) {
  const issues = new Map((input.issues ?? []).map(row => [row.id, row]));
  issues.set("task", issues.get("task") ?? issue({ id: "task", assigneeAgentId: "claude-engineer", createdByAgentId: "coordinator", parentId: "parent" }));
  issues.set("parent", issues.get("parent") ?? issue({ id: "parent", assigneeAgentId: "lead-coordinator" }));
  const owners = new Map<string, GateIssue>();
  const parked: Array<{ issueId: string; blockerIssueId: string }> = [];
  const logs: Array<{ action: string; details: Record<string, unknown> }> = [];
  const deps: MergeGateDependencies = {
    github: () => input.github,
    resolveToken: async () => "token",
    loadIssue: async (_company, id) => issues.get(id) ?? null,
    loadAgentAdapter: async (_company, id) => id.startsWith("claude") ? "claude_local" : "codex_local",
    loadReviews: async () => input.reviews ?? [review()],
    ensureRedMainIssue: async request => {
      const key = `${request.repo}:${request.baseRef}`;
      const existing = owners.get(key);
      if (existing) return { issue: existing, created: false };
      if (!request.createIfMissing) return null;
      const owner = issue({ id: `red-main-${owners.size + 1}`, priority: "critical", status: "todo", assigneeAgentId: "repair-engineer",
        originKind: "merge_gate_red_main", originId: key });
      owners.set(key, owner);
      issues.set(owner.id, owner);
      return { issue: owner, created: true };
    },
    parkOnIssue: async request => { parked.push({ issueId: request.issueId, blockerIssueId: request.blockerIssueId }); },
    log: async entry => { logs.push({ action: entry.action, details: entry.details }); },
  };
  return { deps, issues, owners, parked, logs };
}

const coordinator = { type: "agent" as const, agentId: "coordinator", runId: "run-1" };
const request = (overrides: Partial<Parameters<typeof evaluateAndMerge>[1]> = {}) => ({
  companyId: COMPANY, issueId: "task", repo: "ethanmonlux/facette", pullNumber: 704, actor: coordinator, ...overrides,
});
const accountWebCi = [ok("changes"), ok("shell"), ok("account-web"),
  { kind: "check_run" as const, name: "windows-fast", status: "completed", conclusion: "skipped" }];

describe("merge gate service", () => {
  it("merges a current, green, reviewed head at that exact SHA", async () => {
    const { github, merge } = fakeGitHub({ headChecks: accountWebCi });
    const h = harness({ github });
    const result = await evaluateAndMerge(h.deps, request());
    expect(result).toMatchObject({ outcome: "merged", headSha: HEAD, reasons: [], redMainIssue: null });
    expect(merge).toHaveBeenCalledWith(704, expect.objectContaining({ sha: HEAD, method: "merge" }));
    expect(h.logs.map(entry => entry.action)).toEqual(["merge_gate.merged"]);
  });

  it("lets only the delegating coordinator merge", async () => {
    const { github, merge } = fakeGitHub({ headChecks: accountWebCi });
    const h = harness({ github });
    await expect(evaluateAndMerge(h.deps, request({ actor: { type: "agent", agentId: "claude-engineer", runId: "r" } })))
      .rejects.toThrow(/implementer cannot merge/);
    await expect(evaluateAndMerge(h.deps, request({ actor: { type: "agent", agentId: "someone-else", runId: "r" } })))
      .rejects.toThrow(/Only the coordinator/);
    await expect(evaluateAndMerge(h.deps, request({ actor: { type: "agent", agentId: "lead-coordinator", runId: "r" } })))
      .resolves.toMatchObject({ outcome: "merged" });
    expect(merge).toHaveBeenCalledTimes(1);
  });

  it("needs only CI after a clean update from main since the review", async () => {
    const { github } = fakeGitHub({ headChecks: accountWebCi });
    const h = harness({ github, reviews: [review({ reviewedSha: REVIEWED })] });
    await expect(evaluateAndMerge(h.deps, request())).resolves.toMatchObject({ outcome: "merged" });
  });

  it("refuses a head that is behind its base without merging", async () => {
    const { github, merge } = fakeGitHub({ headChecks: accountWebCi, behindBy: 1 });
    const h = harness({ github });
    const result = await evaluateAndMerge(h.deps, request());
    expect(result).toMatchObject({ outcome: "refused", reasons: [{ code: "base_update_required" }] });
    expect(merge).not.toHaveBeenCalled();
    expect(h.logs.map(entry => entry.action)).toEqual(["merge_gate.refused"]);
  });

  it("stops merges on red main with one owner and parks every dependent task on it", async () => {
    const red = [{ kind: "check_run" as const, name: "windows-fast", status: "completed", conclusion: "failure" }];
    const { github, merge } = fakeGitHub({ headChecks: accountWebCi, baseChecks: red });
    const h = harness({ github, issues: [
      issue({ id: "task-2", assigneeAgentId: "claude-engineer-2", createdByAgentId: "coordinator" }),
    ] });
    const first = await evaluateAndMerge(h.deps, request());
    const second = await evaluateAndMerge(h.deps, request({ issueId: "task-2", pullNumber: 705 }));
    expect(first).toMatchObject({ outcome: "parked", redMainIssue: { id: "red-main-1", created: true }, reasons: [{ code: "main_red" }] });
    expect(second).toMatchObject({ outcome: "parked", redMainIssue: { id: "red-main-1", created: false } });
    expect(h.owners.size).toBe(1);
    expect(h.issues.get("red-main-1")).toMatchObject({ priority: "critical", assigneeAgentId: "repair-engineer" });
    expect(h.parked).toEqual([{ issueId: "task", blockerIssueId: "red-main-1" }, { issueId: "task-2", blockerIssueId: "red-main-1" }]);
    expect(merge).not.toHaveBeenCalled();
  });

  it("lets the fix under the red-main issue merge while main is red", async () => {
    const red = [{ kind: "check_run" as const, name: "windows-fast", status: "completed", conclusion: "failure" }];
    const { github, merge } = fakeGitHub({ headChecks: [...accountWebCi.slice(0, 3), ok("windows-fast"), ok("windows-native")], baseChecks: red });
    const h = harness({ github });
    await reportRedMain(h.deps, { companyId: COMPANY, repo: "ethanmonlux/facette", baseRef: "main", evidence: "windows-fast fails on every PR", reportingIssueId: null, actor: coordinator });
    h.issues.set("fix", issue({ id: "fix", parentId: "red-main-1", assigneeAgentId: "claude-repair", createdByAgentId: "coordinator" }));
    const result = await evaluateAndMerge(h.deps, request({ issueId: "fix" }));
    expect(result).toMatchObject({ outcome: "merged", redMainIssue: { id: "red-main-1" } });
    expect(merge).toHaveBeenCalledTimes(1);
    expect(h.parked).toEqual([]);
  });

  it("keeps merges stopped while a reported red-main issue is open, even with no failing base check", async () => {
    const { github } = fakeGitHub({ headChecks: accountWebCi });
    const h = harness({ github, issues: [issue({ id: "reporter", assigneeAgentId: "claude-engineer-3" })] });
    const reported = await reportRedMain(h.deps, { companyId: COMPANY, repo: "ethanmonlux/facette", baseRef: "main",
      evidence: "windows-fast fails on 3 PRs with the same content-pack test", reportingIssueId: "reporter", actor: coordinator });
    expect(reported).toMatchObject({ created: true, issue: { id: "red-main-1" } });
    expect(h.parked).toEqual([{ issueId: "reporter", blockerIssueId: "red-main-1" }]);
    await expect(evaluateAndMerge(h.deps, request())).resolves.toMatchObject({ outcome: "parked", reasons: [{ code: "main_red" }] });
  });

  it("evaluates without merging, parking or logging on a dry run", async () => {
    const red = [{ kind: "check_run" as const, name: "windows-fast", status: "completed", conclusion: "failure" }];
    const { github, merge } = fakeGitHub({ headChecks: accountWebCi, baseChecks: red });
    const h = harness({ github });
    await expect(evaluateAndMerge(h.deps, request({ dryRun: true }))).resolves.toMatchObject({ outcome: "refused" });
    expect(merge).not.toHaveBeenCalled();
    expect(h.parked).toEqual([]);
    expect(h.logs).toEqual([]);
    const green = harness({ github: fakeGitHub({ headChecks: accountWebCi }).github });
    await expect(evaluateAndMerge(green.deps, request({ dryRun: true }))).resolves.toMatchObject({ outcome: "mergeable" });
  });

  it("does not count a review written by the merging coordinator", async () => {
    const { github } = fakeGitHub({ headChecks: accountWebCi });
    const h = harness({ github, reviews: [review({ reviewerAgentId: "coordinator" })] });
    await expect(evaluateAndMerge(h.deps, request())).resolves.toMatchObject({ outcome: "refused", reasons: [{ code: "review_missing" }] });
  });
});
