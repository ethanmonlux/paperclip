import { describe, expect, it, vi } from "vitest";
import type { MergeGateGitHub } from "./github.js";
import type { MergeGateCheck, MergeReviewAttestation } from "./policy.js";
import { coAuthorModelFamilies, evaluateAndMerge, MERGE_LOCK_BUSY, reportRedMain, type GateIssue, type MergeGateDependencies } from "./service.js";

const HEAD = "a".repeat(40);
const REVIEWED = "b".repeat(40);
const BASE = "c".repeat(40);
const NEW_BASE = "e".repeat(40);
const COMPANY = "company-1";

const ok = (name: string): MergeGateCheck => ({ kind: "check_run", name, status: "completed", conclusion: "success" });

function issue(overrides: Partial<GateIssue> & { id: string }): GateIssue {
  return {
    companyId: COMPANY, identifier: overrides.id.toUpperCase(), title: overrides.id, status: "in_review", priority: "high",
    projectId: "project-1", parentId: null, assigneeAgentId: null, createdByAgentId: null,
    originKind: "manual", originId: null, ...overrides,
  };
}

/** One repository's base branch, shared by every pull request's fake. */
function fakeBase() {
  return { head: BASE };
}

function fakeGitHub(overrides: Partial<{ baseChecks: MergeGateCheck[]; headChecks: MergeGateCheck[]; behindBy: number; headSha: string; base: { head: string } }> = {}) {
  const headSha = overrides.headSha ?? HEAD;
  const base = overrides.base ?? fakeBase();
  // Merging advances the shared base, as GitHub would.
  const merge = vi.fn(async () => { base.head = NEW_BASE; return { merged: true, sha: NEW_BASE, message: "Pull Request successfully merged" }; });
  const github: MergeGateGitHub = {
    pullRequest: async () => ({ state: "open", merged: false, draft: false, headSha, headRef: "sta-1", baseRef: "main", mergeable: true, mergeableState: "clean" }),
    branchHead: async () => base.head,
    compare: async (from, to) => {
      if (from === REVIEWED && to === HEAD) {
        return { status: "ahead", aheadBy: 3, behindBy: 0, totalCommits: 3, complete: true, files: [],
          commits: [{ sha: "m1", parentCount: 1 }, { sha: "m2", parentCount: 1 }, { sha: "merge", parentCount: 2 }] };
      }
      if (from === REVIEWED && to === BASE) {
        return { status: "ahead", aheadBy: 2, behindBy: 0, totalCommits: 2, complete: true, files: [],
          commits: [{ sha: "m1", parentCount: 1 }, { sha: "m2", parentCount: 1 }] };
      }
      if (to === headSha) {
        // compare(base...head): a head built on BASE is behind any newer base.
        return { status: "ahead", aheadBy: 3, behindBy: from === BASE ? (overrides.behindBy ?? 0) : 1, totalCommits: 3, files: [], complete: true,
          commits: [{ sha: "own", parentCount: 1, message: "feat: change\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" }] };
      }
      // compare(base...reviewed): the PR's own diff at review time.
      return { status: "diverged", aheadBy: 1, behindBy: 2, totalCommits: 1, complete: true, commits: [],
        files: [{ filename: "account-web/app/page.tsx", status: "modified", blobSha: "x1", patch: "@@ -1 +1 @@\n-a\n+b" }] };
    },
    pullRequestFiles: async () => [{ filename: "account-web/app/page.tsx", status: "modified", blobSha: "x2", patch: "@@ -4 +4 @@\n-a\n+b" }],
    checks: async sha => ({ complete: true, checks: sha === headSha ? (overrides.headChecks ?? [ok("verify"), ok("shell")]) : (overrides.baseChecks ?? [ok("verify")]) }),
    merge,
  };
  return { github, merge, base };
}

function review(overrides: Partial<MergeReviewAttestation> = {}): MergeReviewAttestation {
  return {
    reviewIssueId: "review", reviewIssueIdentifier: "STA-REVIEW", reviewIssueStatus: "done", reviewerAgentId: "codex-reviewer",
    reviewerModelFamilies: ["openai"], writtenByReviewer: true, scope: "full", reviewedSha: HEAD,
    pullRequest: "ethanmonlux/facette#704", p0: 0, p1: 0, p2: [], ...overrides,
  };
}

function harness(input: {
  github: MergeGateGitHub | ((repo: string) => MergeGateGitHub); reviews?: MergeReviewAttestation[]; issues?: GateIssue[];
  authorFamilies?: string[] | null; authorAgents?: string[]; coordinatorFamilies?: string[]; locks?: Set<string>; onLoadReviews?: () => void;
  legacyCoordinator?: string;
}) {
  const issues = new Map((input.issues ?? []).map(row => [row.id, row]));
  issues.set("task", issues.get("task") ?? issue({ id: "task", assigneeAgentId: "claude-engineer", createdByAgentId: "coordinator", parentId: "parent" }));
  issues.set("parent", issues.get("parent") ?? issue({ id: "parent", assigneeAgentId: "lead-coordinator" }));
  const owners = new Map<string, GateIssue>();
  const parked: Array<{ issueId: string; blockerIssueId: string }> = [];
  const logs: Array<{ action: string; details: Record<string, unknown> }> = [];
  const locks = input.locks ?? new Set<string>();
  const authorQueries: Array<{ issueId: string; excludeAgentId: string | null }> = [];
  const deps: MergeGateDependencies = {
    github: repo => typeof input.github === "function" ? input.github(repo) : input.github,
    resolveToken: async () => "token",
    loadIssue: async (_company, id) => issues.get(id) ?? null,
    loadLegacyDelegation: async (_company, _issueId, agentId) => input.legacyCoordinator === agentId,
    loadTaskAuthorship: async (_company, query) => {
      authorQueries.push(query);
      const families = input.authorFamilies === undefined ? ["anthropic"] : input.authorFamilies;
      return families === null ? null : {
        agentIds: [...(input.authorAgents ?? ["claude-engineer"]), ...(query.excludeAgentId ? [] : ["coordinator"])],
        modelFamilies: [...families, ...(query.excludeAgentId ? [] : input.coordinatorFamilies ?? [])],
      };
    },
    // The database lock is a try-lock shared across server instances.
    withMergeLock: async (key, action) => {
      if (locks.has(key)) return MERGE_LOCK_BUSY;
      locks.add(key);
      try { return await action(); } finally { locks.delete(key); }
    },
    loadReviews: async () => { input.onLoadReviews?.(); return input.reviews ?? [review()]; },
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
  return { deps, issues, owners, parked, logs, authorQueries };
}

const coordinator = { type: "agent" as const, agentId: "coordinator", runId: "run-1" };
const request = (overrides: Partial<Parameters<typeof evaluateAndMerge>[1]> = {}) => ({
  companyId: COMPANY, issueId: "task", repo: "ethanmonlux/facette", pullNumber: 704, actor: coordinator, ...overrides,
});
const facetteAlwaysCi = [ok("changes"), ok("shell"), ok("agent"), ok("account-web"), ok("pr-status-block")];
const accountWebCi = [...facetteAlwaysCi,
  { kind: "check_run" as const, name: "windows-fast", status: "completed", conclusion: "skipped" }];

describe("merge gate service", () => {
  it("keeps a reviewed Facette shell change blocked until exact-head candidate proof exists", async () => {
    const ordinary = [...facetteAlwaysCi, ok("windows-fast"), ok("windows-native")];
    const proof: MergeGateCheck[] = [
      ...["frontend", "candidate", "browser-evidence"].map(name => ({ ...ok(name), headSha: HEAD, checkSuiteId: 91 })),
      { kind: "workflow_run", name: "Internal Windows Candidate", status: "completed", conclusion: "success",
        headSha: HEAD, checkSuiteId: 91, runId: 1234, workflowPath: ".github/workflows/internal-windows.yml" },
    ];
    for (const candidate of [[], proof]) {
      const { github, merge } = fakeGitHub({ headChecks: [...ordinary, ...candidate] });
      github.pullRequestFiles = async () => [{ filename: "shell/src/app.tsx", status: "modified", blobSha: "x", patch: "@@ -1 +1 @@\n-a\n+b" }];
      const result = await evaluateAndMerge(harness({ github }).deps, request());
      expect(result.outcome).toBe(candidate.length === 0 ? "refused" : "merged");
      expect(merge).toHaveBeenCalledTimes(candidate.length === 0 ? 0 : 1);
    }
  });

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

  it("allows a recorded legacy coordinator handoff while rejecting its implementer and unrelated agents", async () => {
    const { github, merge } = fakeGitHub({ headChecks: accountWebCi });
    const h = harness({ github, legacyCoordinator: "coordinator", issues: [
      issue({ id: "task", assigneeAgentId: "coordinator", createdByAgentId: null, parentId: null }),
    ] });
    await expect(evaluateAndMerge(h.deps, request({ actor: { type: "agent", agentId: "claude-engineer", runId: "r" } })))
      .rejects.toThrow(/Only the coordinator/);
    await expect(evaluateAndMerge(h.deps, request({ actor: { type: "agent", agentId: "someone-else", runId: "r" } })))
      .rejects.toThrow(/Only the coordinator/);
    await expect(evaluateAndMerge(h.deps, request())).resolves.toMatchObject({ outcome: "merged" });
    expect(merge).toHaveBeenCalledTimes(1);
  });

  it("does not treat current assignment alone as a legacy handoff", async () => {
    const { github, merge } = fakeGitHub({ headChecks: accountWebCi });
    const h = harness({ github, issues: [issue({ id: "task", assigneeAgentId: "coordinator", createdByAgentId: null, parentId: null })] });
    await expect(evaluateAndMerge(h.deps, request())).rejects.toThrow(/implementer cannot merge/);
    expect(merge).not.toHaveBeenCalled();
  });

  it("counts a legacy coordinator's Codex runs as authorship before or after handoff", async () => {
    const { github, merge } = fakeGitHub({ headChecks: accountWebCi });
    const h = harness({ github, legacyCoordinator: "coordinator", coordinatorFamilies: ["openai"],
      reviews: [review({ reviewerModelFamilies: ["openai"] })], issues: [
        issue({ id: "task", assigneeAgentId: "coordinator", createdByAgentId: null, parentId: null }),
      ] });
    await expect(evaluateAndMerge(h.deps, request())).resolves.toMatchObject({
      outcome: "refused", reasons: [{ code: "review_not_independent" }],
    });
    expect(h.authorQueries).toEqual([{ issueId: "task", excludeAgentId: null }]);
    expect(merge).not.toHaveBeenCalled();
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
    const { github, merge } = fakeGitHub({ headChecks: [...facetteAlwaysCi, ok("windows-fast"), ok("windows-native")], baseChecks: red });
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

  it("serializes merges into one base: of two concurrent green PRs only one merges", async () => {
    const base = fakeBase();
    const first = fakeGitHub({ headChecks: accountWebCi, base });
    const second = fakeGitHub({ headChecks: accountWebCi, base, headSha: "f".repeat(40) });
    const locks = new Set<string>();
    const h1 = harness({ github: first.github, locks });
    const h2 = harness({ github: second.github, locks, reviews: [review({ reviewedSha: "f".repeat(40), pullRequest: "ethanmonlux/facette#705" })] });
    const [one, two] = await Promise.all([evaluateAndMerge(h1.deps, request()), evaluateAndMerge(h2.deps, request({ pullNumber: 705 }))]);
    expect(one).toMatchObject({ outcome: "merged" });
    expect(two).toMatchObject({ outcome: "refused", reasons: [{ code: "merge_in_progress" }] });
    expect(first.merge).toHaveBeenCalledTimes(1);
    expect(second.merge).not.toHaveBeenCalled();
    // Retried after the first landed, the second head is behind the new base.
    await expect(evaluateAndMerge(h2.deps, request({ pullNumber: 705 })))
      .resolves.toMatchObject({ outcome: "refused", reasons: [{ code: "base_update_required", detail: expect.stringContaining("1 commit(s) behind") }] });
    expect(second.merge).not.toHaveBeenCalled();
  });

  it("refuses when the base moves outside the gate while it is checking", async () => {
    const { github, merge, base } = fakeGitHub({ headChecks: accountWebCi });
    const h = harness({ github, onLoadReviews: () => { base.head = NEW_BASE; } });
    await expect(evaluateAndMerge(h.deps, request()))
      .resolves.toMatchObject({ outcome: "refused", reasons: [{ code: "base_update_required", detail: expect.stringContaining("moved") }] });
    expect(merge).not.toHaveBeenCalled();
  });

  it("reads authorship from run provenance and commit trailers, and fails closed without it", async () => {
    const { github } = fakeGitHub({ headChecks: accountWebCi });
    // The implementer is now configured as Codex, but its runs and commits recorded Claude.
    const sameFamily = harness({ github, authorFamilies: ["anthropic"], reviews: [review({ reviewerModelFamilies: ["anthropic"] })] });
    await expect(evaluateAndMerge(sameFamily.deps, request()))
      .resolves.toMatchObject({ outcome: "refused", reasons: [{ code: "review_not_independent" }] });
    // Only the merging coordinator's runs are left out; reviewers' runs count.
    expect(sameFamily.authorQueries).toEqual([{ issueId: "task", excludeAgentId: "coordinator" }]);
    // A run with no recorded model leaves only the trailers, which still name Claude.
    const trailersOnly = harness({ github, authorFamilies: [], reviews: [review({ reviewerModelFamilies: ["anthropic"] })] });
    await expect(evaluateAndMerge(trailersOnly.deps, request()))
      .resolves.toMatchObject({ outcome: "refused", reasons: [{ code: "review_not_independent", detail: expect.stringContaining("anthropic") }] });
    const missing = harness({ github, authorFamilies: null });
    await expect(evaluateAndMerge(missing.deps, request()))
      .resolves.toMatchObject({ outcome: "refused", reasons: [{ code: "review_not_independent", detail: expect.stringContaining("no recorded model") }] });
    expect(coAuthorModelFamilies(["fix\n\nCo-authored-by: Codex <codex@openai.com>", null])).toEqual(["openai"]);
  });

  it("refuses a previous implementer as reviewer after the task is handed to another model (STA-218)", async () => {
    const { github, merge } = fakeGitHub({ headChecks: accountWebCi });
    // codex-reviewer authored part of the PR with Codex, then the task moved to
    // claude-engineer. No co-author trailers name Codex.
    const handedOff = harness({ github, authorAgents: ["claude-engineer", "codex-reviewer"], authorFamilies: ["anthropic", "openai"] });
    await expect(evaluateAndMerge(handedOff.deps, request()))
      .resolves.toMatchObject({ outcome: "refused", reasons: [{ code: "review_not_independent", detail: expect.stringContaining("worked on this task") }] });
    // Another Codex agent reviewing the mixed-authorship change shares a family.
    const mixed = harness({ github, authorAgents: ["claude-engineer", "codex-implementer"], authorFamilies: ["anthropic", "openai"] });
    await expect(evaluateAndMerge(mixed.deps, request()))
      .resolves.toMatchObject({ outcome: "refused", reasons: [{ code: "review_not_independent", detail: expect.stringContaining("openai") }] });
    expect(merge).not.toHaveBeenCalled();
  });

  it("does not count a review written by the merging coordinator", async () => {
    const { github } = fakeGitHub({ headChecks: accountWebCi });
    const h = harness({ github, reviews: [review({ reviewerAgentId: "coordinator" })] });
    await expect(evaluateAndMerge(h.deps, request())).resolves.toMatchObject({ outcome: "refused", reasons: [{ code: "review_missing" }] });
  });
});

