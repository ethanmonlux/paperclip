import { describe, expect, it } from "vitest";
import {
  classifyHeadCommits,
  classifyOwnDiffChange,
  decideMerge,
  evaluateBaseCi,
  evaluateHeadCi,
  evaluateReviewCoverage,
  parseMergeReviewDocument,
  repositoryMergePolicy,
  requiredPathScopedChecks,
  type MergeGateCheck,
  type MergeReviewAttestation,
} from "./policy.js";

const HEAD = "a".repeat(40);
const REVIEWED = "b".repeat(40);
const facette = repositoryMergePolicy("ethanmonlux/facette");

const check = (name: string, conclusion: string | null, status = "completed"): MergeGateCheck =>
  ({ kind: "check_run", name, status, conclusion });
const workflow = (name: string, conclusion: string | null, status = "completed"): MergeGateCheck =>
  ({ kind: "workflow_run", name, status, conclusion });

const greenFacette = [
  check("changes", "success"), check("shell", "success"), check("agent", "success"),
  check("account-web", "success"), check("pr-status-block", "success"), workflow("CI", "success"),
];

function review(overrides: Partial<MergeReviewAttestation> = {}): MergeReviewAttestation {
  return {
    reviewIssueId: "review-1", reviewIssueIdentifier: "STA-900", reviewIssueStatus: "done",
    reviewerAgentId: "codex-reviewer", reviewerAdapterType: "codex_local", writtenByReviewer: true,
    scope: "full", reviewedSha: HEAD, pullRequest: "ethanmonlux/facette#704", p0: 0, p1: 0, p2: [],
    ...overrides,
  };
}

const author = { agentId: "claude-engineer", adapterType: "claude_local" };

describe("conservative path filters", () => {
  it("replays STA-163: a .github/scripts change needs windows-fast, and a skipped windows-fast refuses the merge", () => {
    const changedFiles = [".github/scripts/content-pack.test.mjs", ".github/scripts/lib/content-pack.mjs"];
    const required = requiredPathScopedChecks({ policy: facette, changedFiles });
    expect(required).toEqual(["windows-fast", "windows-native"]);
    const reasons = evaluateHeadCi({
      headSha: HEAD, checksComplete: true, requiredChecks: required, changedFiles,
      checks: [...greenFacette, check("windows-fast", "skipped"), check("windows-native", "skipped")],
    });
    expect(reasons.map(reason => reason.code)).toEqual(["required_check_skipped", "required_check_skipped"]);
    expect(reasons[0]!.detail).toContain("windows-fast was skipped by a CI path filter");
  });

  it("treats an unknown path as needing Windows evidence", () => {
    expect(requiredPathScopedChecks({ policy: facette, changedFiles: ["shell/app/launcher.tsx"] }))
      .toEqual(["windows-fast", "windows-native"]);
    expect(requiredPathScopedChecks({ policy: facette, changedFiles: ["brand/new-logo.svg", "docs/a.md"] }))
      .toEqual(["windows-fast", "windows-native"]);
    // An unreadable or empty file list is unknown too.
    expect(requiredPathScopedChecks({ policy: facette, changedFiles: null })).toEqual(["windows-fast", "windows-native"]);
    expect(requiredPathScopedChecks({ policy: facette, changedFiles: [] })).toEqual(["windows-fast", "windows-native"]);
  });

  it("lets a filter skip Windows only when every file is known to be irrelevant", () => {
    const changedFiles = ["account-web/app/page.tsx", "docs/billing.md", "README.md"];
    expect(requiredPathScopedChecks({ policy: facette, changedFiles })).toEqual([]);
    expect(evaluateHeadCi({
      headSha: HEAD, checksComplete: true, requiredChecks: [], changedFiles,
      checks: [...greenFacette, check("windows-fast", "skipped"), check("windows-native", "skipped")],
    })).toEqual([]);
  });

  it("never lets a Windows script count as irrelevant, in any repository", () => {
    expect(requiredPathScopedChecks({ policy: facette, changedFiles: ["docs/install.ps1"] })).toEqual(["windows-fast", "windows-native"]);
    const generic = repositoryMergePolicy("ethanmonlux/paperclip");
    const reasons = evaluateHeadCi({
      headSha: HEAD, checksComplete: true, changedFiles: ["scripts/install.cmd"],
      requiredChecks: requiredPathScopedChecks({ policy: generic, changedFiles: ["scripts/install.cmd"] }),
      checks: [check("verify", "success"), check("runner-windows", "skipped")],
    });
    expect(reasons).toMatchObject([{ code: "required_check_skipped", detail: expect.stringContaining("runner-windows") }]);
  });

  it("requires a needed check that never appeared", () => {
    const reasons = evaluateHeadCi({
      headSha: HEAD, checksComplete: true, changedFiles: ["agent/src/main.mjs"],
      requiredChecks: ["windows-fast", "windows-native"], checks: [...greenFacette, check("windows-fast", "success")],
    });
    expect(reasons).toMatchObject([{ code: "required_check_skipped", detail: expect.stringContaining("windows-native did not run") }]);
  });
});

describe("exact-head CI", () => {
  it("does not merge while slow CI is still running, and does not call it failed", () => {
    const reasons = evaluateHeadCi({
      headSha: HEAD, checksComplete: true, requiredChecks: [], changedFiles: ["docs/a.md"],
      checks: [check("shell", "success"), check("windows-native", null, "in_progress"), workflow("CI", null, "in_progress")],
    });
    expect(reasons).toMatchObject([{ code: "ci_pending" }]);
  });

  it("refuses absent, failed, cancelled or partially read CI", () => {
    const base = { headSha: HEAD, requiredChecks: [], changedFiles: ["docs/a.md"] };
    expect(evaluateHeadCi({ ...base, checksComplete: true, checks: [] })).toMatchObject([{ code: "ci_absent" }]);
    expect(evaluateHeadCi({ ...base, checksComplete: true, checks: [check("shell", "failure")] })).toMatchObject([{ code: "ci_failed" }]);
    expect(evaluateHeadCi({ ...base, checksComplete: true, checks: [check("shell", "cancelled")] })).toMatchObject([{ code: "ci_failed" }]);
    expect(evaluateHeadCi({ ...base, checksComplete: false, checks: [check("shell", "success")] })).toMatchObject([{ code: "ci_incomplete" }]);
  });
});

describe("red main", () => {
  it("is red on a failed base check, not on a cancelled or skipped one", () => {
    expect(evaluateBaseCi({ baseSha: HEAD, checks: [check("windows-fast", "failure"), check("shell", "success")] }))
      .toEqual({ red: true, failing: ["windows-fast"] });
    expect(evaluateBaseCi({ baseSha: HEAD, checks: [check("docker", "cancelled"), check("x", "skipped"), check("y", null, "in_progress")] }))
      .toEqual({ red: false, failing: [] });
  });

  it("stops every merge except the exempt fix", () => {
    const pr = { state: "open", merged: false, draft: false, headSha: HEAD, mergeable: true, mergeableState: "clean", behindBy: 0 };
    const red = { red: true, exempt: false, detail: "main is red; STA-950 owns the fix" };
    expect(decideMerge({ pullRequest: pr, expectedHeadSha: null, ciReasons: [], reviewReasons: [], requiredChecks: [], redMain: red }))
      .toMatchObject({ mergeable: false, reasons: [{ code: "main_red" }] });
    expect(decideMerge({ pullRequest: pr, expectedHeadSha: null, ciReasons: [], reviewReasons: [], requiredChecks: [], redMain: { ...red, exempt: true } }))
      .toMatchObject({ mergeable: true, reasons: [] });
  });
});

describe("current base", () => {
  const ready = { expectedHeadSha: null, ciReasons: [], reviewReasons: [], requiredChecks: [], redMain: { red: false, exempt: false, detail: "" } };
  it("refuses a head behind its base or conflicting, and a moved head", () => {
    const pr = { state: "open", merged: false, draft: false, headSha: HEAD, mergeable: true, mergeableState: "behind", behindBy: 2 };
    expect(decideMerge({ ...ready, pullRequest: pr }).reasons).toMatchObject([{ code: "base_update_required", detail: expect.stringContaining("2 commit(s) behind") }]);
    expect(decideMerge({ ...ready, pullRequest: { ...pr, mergeable: false, mergeableState: "dirty", behindBy: 3 } }).reasons)
      .toMatchObject([{ code: "base_update_required", detail: expect.stringContaining("conflicts") }]);
    expect(decideMerge({ ...ready, pullRequest: { ...pr, behindBy: null } }).reasons).toMatchObject([{ code: "base_update_required" }]);
    expect(decideMerge({ ...ready, expectedHeadSha: REVIEWED, pullRequest: { ...pr, behindBy: 0 } }).reasons)
      .toMatchObject([{ code: "head_moved" }]);
  });
  it("merges a current, green, reviewed head", () => {
    const pr = { state: "open", merged: false, draft: false, headSha: HEAD, mergeable: true, mergeableState: "clean", behindBy: 0 };
    expect(decideMerge({ ...ready, pullRequest: pr })).toEqual({ mergeable: true, reasons: [], requiredChecks: [] });
  });
});

describe("review coverage and merge bar", () => {
  const evaluate = (reviews: MergeReviewAttestation[], delta: Parameters<typeof evaluateReviewCoverage>[0]["deltaFor"] = () => ({ kind: "identical" })) =>
    evaluateReviewCoverage({ pullRequest: "ethanmonlux/facette#704", headSha: HEAD, author, reviews, deltaFor: delta });

  it("accepts an independent cross-model review of the exact head", () => {
    expect(evaluate([review()])).toEqual([]);
  });

  it("needs only CI after a clean update from main", () => {
    expect(evaluate([review({ reviewedSha: REVIEWED })], () => ({ kind: "clean_base_update" }))).toEqual([]);
  });

  it("needs a focused conflict-hunk recheck after resolved conflicts", () => {
    const conflicted = () => ({ kind: "conflict_resolution" as const, files: ["shell/app/page.tsx"] });
    expect(evaluate([review({ reviewedSha: REVIEWED })], conflicted))
      .toMatchObject([{ code: "conflict_recheck_required", detail: expect.stringContaining("shell/app/page.tsx") }]);
    expect(evaluate([review({ reviewedSha: REVIEWED }), review({ reviewIssueId: "review-2", scope: "conflict_hunks", reviewedSha: HEAD })], conflicted))
      .toEqual([]);
  });

  it("needs a new review when source changed after the review", () => {
    expect(evaluate([review({ reviewedSha: REVIEWED })], () => ({ kind: "source_changed", detail: "1 new source commit(s)" })))
      .toMatchObject([{ code: "review_stale" }]);
  });

  it("rejects missing, unfinished, self, same-model, or unattributed reviews", () => {
    expect(evaluate([])).toMatchObject([{ code: "review_missing" }]);
    expect(evaluate([review({ pullRequest: "ethanmonlux/facette#705" })])).toMatchObject([{ code: "review_missing" }]);
    expect(evaluate([review({ reviewIssueStatus: "in_progress" })])).toMatchObject([{ code: "review_not_independent" }]);
    expect(evaluate([review({ reviewerAgentId: "claude-engineer" })])).toMatchObject([{ code: "review_not_independent" }]);
    expect(evaluate([review({ reviewerAdapterType: "claude_local" })])).toMatchObject([{ code: "review_not_independent", detail: expect.stringContaining("cross-model") }]);
    expect(evaluate([review({ writtenByReviewer: false })])).toMatchObject([{ code: "review_not_independent" }]);
  });

  it("holds the merge bar: 0 P0, 0 P1, every P2 tracked", () => {
    expect(evaluate([review({ p1: 1 })])).toMatchObject([{ code: "merge_bar_failed" }]);
    expect(evaluate([review({ p2: ["FAC-901", "tidy later"] })])).toMatchObject([{ code: "merge_bar_failed", detail: expect.stringContaining("tidy") }]);
    expect(evaluate([review({ p2: ["FAC-901", "STA-12"] })])).toEqual([]);
  });
});

describe("merge-review document", () => {
  it("parses the reviewer's record", () => {
    expect(parseMergeReviewDocument([
      "# Review", "", `- pullRequest: ethanmonlux/facette#704`, `- reviewedSha: \`${HEAD.toUpperCase()}\``,
      "- scope: full", "- p0: 0", "- p1: 0", "- p2: FAC-901, FAC-902",
    ].join("\n"))).toEqual({ pullRequest: "ethanmonlux/facette#704", reviewedSha: HEAD, scope: "full", p0: 0, p1: 0, p2: ["FAC-901", "FAC-902"] });
    expect(parseMergeReviewDocument(`reviewedSha: ${HEAD}\nscope: conflict_hunks\np0: 0\np1: 0\np2: none`))
      .toMatchObject({ scope: "conflict_hunks", p2: [] });
  });
  it("rejects records without an exact SHA or finding counts", () => {
    expect(parseMergeReviewDocument("reviewedSha: abc123\np0: 0\np1: 0")).toBeNull();
    expect(parseMergeReviewDocument(`reviewedSha: ${HEAD}\np0: 0`)).toBeNull();
    expect(parseMergeReviewDocument(`reviewedSha: ${HEAD}\nscope: partial\np0: 0\np1: 0`)).toBeNull();
  });
});

describe("head delta since review", () => {
  it("classifies merges from base versus new source commits", () => {
    const base = new Set(["m1", "m2"]);
    expect(classifyHeadCommits({ reviewedSha: REVIEWED, headSha: HEAD, status: "ahead", complete: true, baseCommitShas: base,
      commits: [{ sha: "m1", parentCount: 1 }, { sha: "m2", parentCount: 1 }, { sha: "merge", parentCount: 2 }] })).toBe("merges_from_base");
    expect(classifyHeadCommits({ reviewedSha: REVIEWED, headSha: HEAD, status: "ahead", complete: true, baseCommitShas: base,
      commits: [{ sha: "merge", parentCount: 2 }, { sha: "fix", parentCount: 1 }] })).toMatchObject({ sourceChanged: expect.stringContaining("1 new source commit") });
    expect(classifyHeadCommits({ reviewedSha: REVIEWED, headSha: HEAD, status: "diverged", complete: true, baseCommitShas: base, commits: [] }))
      .toMatchObject({ sourceChanged: expect.stringContaining("rewritten") });
    expect(classifyHeadCommits({ reviewedSha: HEAD, headSha: HEAD, status: "identical", complete: true, baseCommitShas: base, commits: [] })).toBe("identical");
  });

  it("treats the PR's own diff as unchanged when only line numbers moved", () => {
    const reviewed = [{ filename: "a.ts", status: "modified", blobSha: "1", patch: "@@ -10,3 +10,4 @@\n ctx\n+added\n ctx" }];
    const shifted = [{ filename: "a.ts", status: "modified", blobSha: "2", patch: "@@ -14,3 +14,4 @@\n ctx\n+added\n ctx" }];
    expect(classifyOwnDiffChange(reviewed, shifted)).toEqual({ clean: true });
    const resolved = [{ filename: "a.ts", status: "modified", blobSha: "3", patch: "@@ -14,3 +14,4 @@\n ctx\n+added differently\n ctx" }];
    expect(classifyOwnDiffChange(reviewed, resolved)).toEqual({ clean: false, files: ["a.ts"] });
    expect(classifyOwnDiffChange(reviewed, [...shifted, { filename: "b.ts", status: "added", blobSha: "4", patch: "+x" }]))
      .toEqual({ clean: false, files: ["b.ts"] });
  });
});
