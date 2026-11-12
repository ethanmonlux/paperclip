import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  classifyHeadCommits,
  classifyOwnDiffChange,
  decideMerge,
  evaluateBaseCi,
  evaluateHeadCi,
  evaluateReviewCoverage,
  modelFamiliesFromRunUsage,
  modelFamily,
  parseMergeReviewDocument,
  repositoryMergePolicy,
  requiredPathScopedChecks,
  type MergeGateCheck,
  type MergeReviewAttestation,
} from "./policy.js";

const HEAD = "a".repeat(40);
const REVIEWED = "b".repeat(40);
const facette = repositoryMergePolicy("ethanmonlux/facette");
const paperclip = repositoryMergePolicy("ethanmonlux/paperclip");
const unknownRepo = repositoryMergePolicy("ethanmonlux/other");

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
    reviewerAgentId: "codex-reviewer", reviewerModelFamilies: ["openai"], writtenByReviewer: true, sourceAuthorAgentIds: null,
    scope: "full", reviewedSha: HEAD, pullRequest: "ethanmonlux/facette#704", p0: 0, p1: 0, p2: [],
    ...overrides,
  };
}

const author = { agentIds: ["claude-engineer"], modelFamilies: ["anthropic"] };

describe("conservative path filters", () => {
  it("replays STA-163: a .github/scripts change needs windows-fast, and a skipped windows-fast refuses the merge", () => {
    const changedFiles = [".github/scripts/content-pack.test.mjs", ".github/scripts/lib/content-pack.mjs"];
    const required = requiredPathScopedChecks({ policy: facette, changedFiles });
    expect(required).toEqual(["windows-fast", "windows-native"]);
    const reasons = evaluateHeadCi({
      headSha: HEAD, policy: facette, checksComplete: true, requiredChecks: required, changedFiles,
      checks: [...greenFacette, check("windows-fast", "skipped"), check("windows-native", "skipped")],
    });
    expect(reasons.map(reason => reason.code)).toEqual(["required_check_skipped", "required_check_skipped"]);
    expect(reasons[0]!.detail).toContain("windows-fast was skipped by a CI path filter");
  });

  it("treats an unknown path as needing Windows evidence", () => {
    expect(requiredPathScopedChecks({ policy: facette, changedFiles: ["shell/app/launcher.tsx"] }))
      .toEqual(["windows-fast", "windows-native", "frontend", "candidate", "browser-evidence"]);
    expect(requiredPathScopedChecks({ policy: facette, changedFiles: ["brand/new-logo.svg", "docs/a.md"] }))
      .toEqual(["windows-fast", "windows-native"]);
    // An unreadable or empty file list is unknown too.
    expect(requiredPathScopedChecks({ policy: facette, changedFiles: null })).toEqual(["windows-fast", "windows-native", "frontend", "candidate", "browser-evidence"]);
    expect(requiredPathScopedChecks({ policy: facette, changedFiles: [] })).toEqual(["windows-fast", "windows-native", "frontend", "candidate", "browser-evidence"]);
  });

  it("lets a filter skip Windows only when every file is known to be irrelevant", () => {
    const changedFiles = ["account-web/app/page.tsx", "docs/billing.md", "README.md"];
    expect(requiredPathScopedChecks({ policy: facette, changedFiles })).toEqual([]);
    expect(evaluateHeadCi({
      headSha: HEAD, policy: facette, checksComplete: true, requiredChecks: [], changedFiles,
      checks: [...greenFacette, check("windows-fast", "skipped"), check("windows-native", "skipped")],
    })).toEqual([]);
  });

  it("never lets a Windows script count as irrelevant, in any repository", () => {
    expect(requiredPathScopedChecks({ policy: facette, changedFiles: ["docs/install.ps1"] })).toEqual(["windows-fast", "windows-native"]);
    const reasons = evaluateHeadCi({
      headSha: HEAD, policy: unknownRepo, checksComplete: true, changedFiles: ["scripts/install.cmd"],
      requiredChecks: requiredPathScopedChecks({ policy: unknownRepo, changedFiles: ["scripts/install.cmd"] }),
      checks: [check("verify", "success"), check("runner-windows", "skipped")],
    });
    expect(reasons).toMatchObject([{ code: "required_check_skipped", detail: expect.stringContaining("runner-windows") }]);
  });

  it("requires a needed check that never appeared", () => {
    const reasons = evaluateHeadCi({
      headSha: HEAD, policy: facette, checksComplete: true, changedFiles: ["agent/src/main.mjs"],
      requiredChecks: ["windows-fast", "windows-native"], checks: [...greenFacette, check("windows-fast", "success")],
    });
    expect(reasons).toMatchObject([{ code: "required_check_skipped", detail: expect.stringContaining("windows-native did not run") }]);
  });
});

describe("staged Facette candidate proof (FAC-151)", () => {
  const changedFiles = ["shell/src/app.tsx"];
  const ordinaryCi = [...greenFacette, check("windows-fast", "success"), check("windows-native", "success")];
  const candidateJobs = ["frontend", "candidate", "browser-evidence"].map(name =>
    ({ ...check(name, "success"), headSha: HEAD, checkSuiteId: 91 }));
  const candidateRun: MergeGateCheck = { ...workflow("Internal Windows Candidate", "success"),
    headSha: HEAD, checkSuiteId: 91, runId: 1234, runAttempt: 1, createdAt: "2026-11-11T12:00:00Z",
    workflowPath: ".github/workflows/internal-windows.yml" };
  const evaluate = (candidateChecks: MergeGateCheck[], files: string[] = changedFiles) => evaluateHeadCi({
    headSha: HEAD, policy: facette, changedFiles: files, checksComplete: true,
    checks: [...ordinaryCi, ...candidateChecks], requiredChecks: requiredPathScopedChecks({ policy: facette, changedFiles: files }),
  });

  it("requires the finished-candidate run even when ordinary CI is green", () => {
    expect(evaluate([]).map(reason => reason.detail)).toEqual(expect.arrayContaining([
      expect.stringContaining("candidate did not run"), expect.stringContaining("one completed .github/workflows/internal-windows.yml run"),
    ]));
    expect(evaluate([...candidateJobs, candidateRun])).toEqual([]);
  });

  it("does not accept an older head, another workflow, mixed suites or unbound same-named jobs", () => {
    for (const invalid of [
      [...candidateJobs, { ...candidateRun, headSha: REVIEWED }],
      [...candidateJobs, { ...candidateRun, workflowPath: ".github/workflows/ci.yml" }],
      [...candidateJobs.map(job => job.name === "candidate" ? { ...job, checkSuiteId: 92 } : job), candidateRun],
      [...candidateJobs.map(job => ({ ...job, headSha: REVIEWED })), candidateRun],
      [...candidateJobs.map(job => ({ ...job, checkSuiteId: null })), candidateRun],
      [...candidateJobs, { ...candidateRun, runId: null }],
    ]) expect(evaluate(invalid)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "required_check_skipped", detail: expect.stringContaining("one completed") }),
    ]));
  });

  it("requires actual success for every candidate job and the workflow", () => {
    for (const conclusion of ["neutral", "skipped", "cancelled", "failure", null]) {
      expect(evaluate([...candidateJobs.map(job => job.name === "browser-evidence" ? { ...job, conclusion } : job), candidateRun]).length).toBeGreaterThan(0);
      expect(evaluate([...candidateJobs, { ...candidateRun, conclusion }]).length).toBeGreaterThan(0);
    }
    expect(evaluate([...candidateJobs, { ...candidateRun, status: "in_progress", conclusion: null }]))
      .toMatchObject([{ code: "ci_pending" }]);
  });

  it("uses the newest candidate run without letting old cancellations or failures poison a successful retry", () => {
    for (const conclusion of ["cancelled", "failure"]) {
      const previousRun = { ...candidateRun, runId: 1233, checkSuiteId: 90, createdAt: "2026-11-11T11:00:00Z", conclusion };
      const previousJobs = candidateJobs.map(job => ({ ...job, checkSuiteId: 90, conclusion }));
      const checks = [previousRun, ...candidateJobs, ...previousJobs, candidateRun];
      expect(evaluate(checks)).toEqual([]);
      expect(evaluateBaseCi({ baseSha: HEAD, policy: facette, checks })).toEqual({ red: false, failing: [] });
      expect(evaluate([...checks, check("unrelated-linux-test", "failure")])).toMatchObject([{ code: "ci_failed" }]);
    }
  });

  it("never cherry-picks an older success over a newer candidate failure, cancellation, pending or empty run", () => {
    for (const conclusion of ["failure", "cancelled", "skipped", "neutral", "success"]) {
      const latest = { ...candidateRun, runId: 1235, checkSuiteId: 92, createdAt: "2026-11-11T13:00:00Z", conclusion };
      expect(evaluate([latest, ...candidateJobs, candidateRun]).length).toBeGreaterThan(0);
    }
    expect(evaluate([...candidateJobs, candidateRun, { ...candidateRun, runId: 1235, checkSuiteId: 92,
      createdAt: "2026-11-11T13:00:00Z", status: "queued", conclusion: null }])).toMatchObject([{ code: "ci_pending" }]);
    expect(evaluate([...candidateJobs, candidateRun, { ...candidateRun, runId: 1235, checkSuiteId: 92, createdAt: null }]).length).toBeGreaterThan(0);
  });

  it("uses the latest named job within a rerun attempt and retains a latest job failure", () => {
    const jobs = candidateJobs.map((job, index) => ({ ...job, checkRunId: 100 + index }));
    const failedPrior = { ...jobs[1]!, checkRunId: 50, conclusion: "failure" };
    expect(evaluate([failedPrior, ...jobs, { ...candidateRun, runAttempt: 2 }])).toEqual([]);
    expect(evaluate([failedPrior, ...jobs, { ...jobs[1]!, checkRunId: 150, conclusion: "failure" }, { ...candidateRun, runAttempt: 3 }]))
      .toMatchObject([{ code: "ci_failed" }]);
  });

  it("exempts only the exact whole CI-maintenance diff and still requires ordinary Windows proof", () => {
    const maintenance = [
      ".github/workflows/internal-windows.yml",
      ".github/scripts/detect-changed-paths.sh",
      ".github/scripts/detect-changed-paths.test.sh",
      ".github/scripts/internal-windows-workflow.test.mjs",
    ];
    expect(requiredPathScopedChecks({ policy: facette, changedFiles: maintenance })).toEqual(["windows-fast", "windows-native"]);
    expect(evaluate([], maintenance)).toEqual([]);
    for (const extra of ["shell/src/app.tsx", "agent/src/main.mjs", "shell/tests/osrs-internal-windows.test.mjs", ".github/scripts/arbitrary.test.mjs", "docs/a.md"]) {
      expect(requiredPathScopedChecks({ policy: facette, changedFiles: [...maintenance, extra] }))
        .toEqual(["windows-fast", "windows-native", "frontend", "candidate", "browser-evidence"]);
    }
    expect(evaluateHeadCi({ headSha: HEAD, policy: facette, changedFiles: maintenance, checksComplete: true,
      requiredChecks: requiredPathScopedChecks({ policy: facette, changedFiles: maintenance }),
      checks: [...greenFacette, check("windows-fast", "skipped"), check("windows-native", "skipped")],
    }).map(reason => reason.detail)).toEqual(expect.arrayContaining([
      expect.stringContaining("windows-fast was skipped"), expect.stringContaining("windows-native was skipped"),
    ]));
  });

  it("preserves the previous candidate workflow's source scope", () => {
    for (const file of ["account-web/app/page.tsx", "docs/setup.md", "x4/manifest.json"]) {
      expect(requiredPathScopedChecks({ policy: facette, changedFiles: [file] })).not.toContain("candidate");
    }
    for (const file of ["shell/tests/new.test.ts", "agent/src/server.mjs"]) {
      expect(requiredPathScopedChecks({ policy: facette, changedFiles: [file] })).toContain("candidate");
    }
  });
});

describe("required CI coverage", () => {
  it("never treats all-skipped CI as green", () => {
    const reasons = evaluateHeadCi({ headSha: HEAD, policy: unknownRepo, checksComplete: true, requiredChecks: [], changedFiles: ["server/src/app.ts"],
      checks: [check("tests", "skipped"), workflow("CI", "skipped")] });
    expect(reasons).toMatchObject([{ code: "ci_absent", detail: expect.stringContaining("No check run passed") }]);
  });

  it("refuses a skipped non-Windows suite on an unknown Facette path even when both Windows jobs passed", () => {
    const changedFiles = ["new-module/engine.ts"];
    const requiredChecks = requiredPathScopedChecks({ policy: facette, changedFiles });
    const reasons = evaluateHeadCi({ headSha: HEAD, policy: facette, checksComplete: true, requiredChecks, changedFiles,
      checks: [check("changes", "success"), check("shell", "skipped"), check("agent", "success"), check("account-web", "success"),
        check("pr-status-block", "success"), check("windows-fast", "success"), check("windows-native", "success")] });
    expect(reasons).toMatchObject([{ code: "required_check_skipped", detail: expect.stringContaining("shell runs on every change") }]);
  });

  it("refuses an always-run suite that never appeared", () => {
    const reasons = evaluateHeadCi({ headSha: HEAD, policy: facette, checksComplete: true, requiredChecks: [], changedFiles: ["docs/a.md"],
      checks: greenFacette.filter(entry => entry.name !== "agent") });
    expect(reasons).toMatchObject([{ code: "required_check_skipped", detail: expect.stringContaining("agent runs on every change") }]);
  });

  it("refuses any skip in an unknown repository, and allows only the listed selector skips in paperclip", () => {
    expect(evaluateHeadCi({ headSha: HEAD, policy: unknownRepo, checksComplete: true, requiredChecks: [], changedFiles: ["src/a.ts"],
      checks: [check("lint", "success"), check("tests", "skipped")] }))
      .toMatchObject([{ code: "required_check_skipped", detail: expect.stringContaining("tests was skipped") }]);
    const paperclipGreen = [check("ci / policy", "success"), check("ci / verify", "success"), check("ci / e2e", "success"),
      check("ci / Typecheck + Release Registry", "success"), check("ci / Build", "success"),
      check("ci / General tests (server (1/12))", "success"), check("ci / Verify serialized server suites (1/9)", "success"),
      check("ci / Select Vitest files", "skipped"), workflow("PR", "success"), workflow("Storybook Visual", "skipped")];
    expect(evaluateHeadCi({ headSha: HEAD, policy: paperclip, checksComplete: true, requiredChecks: [], changedFiles: ["server/src/app.ts"], checks: paperclipGreen }))
      .toEqual([]);
    // A plan-skipped shard counts only behind a green ci / verify.
    expect(evaluateHeadCi({ headSha: HEAD, policy: paperclip, checksComplete: true, requiredChecks: [], changedFiles: ["server/src/app.ts"],
      checks: [...paperclipGreen, check("ci / General tests (server (2/12))", "skipped")] })).toEqual([]);
    expect(evaluateHeadCi({ headSha: HEAD, policy: paperclip, checksComplete: true, requiredChecks: [], changedFiles: ["server/src/app.ts"],
      checks: [...paperclipGreen.filter(entry => entry.name !== "ci / verify"), check("ci / General tests (server (2/12))", "skipped")] }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: "required_check_skipped", detail: expect.stringContaining("server (2/12)") })]));
    expect(evaluateHeadCi({ headSha: HEAD, policy: paperclip, checksComplete: true, requiredChecks: [], changedFiles: ["server/src/app.ts"],
      checks: paperclipGreen.filter(entry => entry.name !== "ci / Build") }))
      .toMatchObject([{ code: "required_check_skipped", detail: expect.stringContaining("ci / Build runs on every change") }]);
  });
});

/** Every check run GitHub reported on an ordinary green paperclip PR (#30, 2026-11-09). */
const PAPERCLIP_ORDINARY_PR: MergeGateCheck[] = [
  ...["ci / gate / Select trusted runner", "ci / policy", "ci / verify", "ci / e2e", "ci / Typecheck + Release Registry", "ci / Build",
    "ci / Docker context integrity", "ci / Sandbox provider tests", "ci / Runner support suite", "ci / Canary Dry Run",
    ...Array.from({ length: 12 }, (_, i) => `ci / General tests (server (${i + 1}/12))`),
    ...Array.from({ length: 3 }, (_, i) => `ci / General tests (chat (${i + 1}/3))`),
    "ci / General tests (workspaces-a (1/2))", "ci / General tests (workspaces-a (2/2))",
    "ci / General tests (workspaces-b)", "ci / General tests (workspaces-c)",
    ...Array.from({ length: 9 }, (_, i) => `ci / Verify serialized server suites (${i + 1}/9)`),
    ...Array.from({ length: 8 }, (_, i) => `ci / e2e shard (${i + 1}/8)`),
    ...["static checks", "rust", "vitest package (1/3)", "vitest package (2/3)", "vitest package (3/3)", "vitest native server"]
      .map(lane => `ci / Verify Paperclip Runner (${lane})`),
  ].map(name => check(name, "success")),
  check("ci / Select Vitest files", "skipped"),
  check("Storybook visual regression", "skipped"),
  check("Deploy selected branch Storybook", "skipped"),
];

describe("paperclip CI policy (STA-218)", () => {
  const evaluate = (checks: MergeGateCheck[], changedFiles = ["server/src/app.ts"]) => evaluateHeadCi({
    headSha: HEAD, policy: paperclip, checksComplete: true, checks, changedFiles,
    requiredChecks: requiredPathScopedChecks({ policy: paperclip, changedFiles }),
  });

  it("accepts the complete observed job set of an ordinary green PR, including its Storybook skips", () => {
    expect(PAPERCLIP_ORDINARY_PR).toHaveLength(55);
    expect(evaluate(PAPERCLIP_ORDINARY_PR)).toEqual([]);
  });

  it("accepts a suite the CI plan skipped only when ci / verify or ci / e2e passed", () => {
    const planSkipped = PAPERCLIP_ORDINARY_PR.map(entry =>
      /Docker context|e2e shard/.test(entry.name) ? { ...entry, conclusion: "skipped" } : entry);
    expect(evaluate(planSkipped)).toEqual([]);
    const reasons = evaluate(planSkipped.filter(entry => entry.name !== "ci / verify" && entry.name !== "ci / e2e"));
    expect(reasons.map(reason => reason.detail)).toEqual(expect.arrayContaining([
      expect.stringContaining("ci / verify runs on every change"),
      expect.stringContaining("ci / e2e runs on every change"),
      expect.stringContaining("ci / Docker context integrity was skipped"),
      expect.stringContaining("ci / e2e shard (1/8) was skipped"),
    ]));
  });

  it("accepts a change-scoped UI PR whose plan skipped every server suite behind a green ci / verify (STA-223)", () => {
    const uiOnly = PAPERCLIP_ORDINARY_PR.map(entry =>
      /General tests \((server|chat)|serialized server|e2e shard|Verify Paperclip Runner|Docker context|Canary|Runner support/.test(entry.name)
        ? { ...entry, conclusion: "skipped" } : entry);
    expect(evaluate(uiOnly, ["ui/src/components/Sidebar.tsx"])).toEqual([]);
    const withoutVerify = uiOnly.filter(entry => entry.name !== "ci / verify");
    expect(evaluate(withoutVerify, ["ui/src/components/Sidebar.tsx"]).map(reason => reason.detail)).toEqual(expect.arrayContaining([
      expect.stringContaining("ci / verify runs on every change"),
      expect.stringContaining("ci / General tests (server (1/12)) was skipped"),
      expect.stringContaining("ci / Verify serialized server suites (1/9) was skipped"),
    ]));
  });

  it("still refuses a skipped required suite, even with ci / verify green", () => {
    const skippedBuild = PAPERCLIP_ORDINARY_PR.map(entry => entry.name === "ci / Build" ? { ...entry, conclusion: "skipped" } : entry);
    expect(evaluate(skippedBuild)).toMatchObject([{ code: "required_check_skipped", detail: expect.stringContaining("ci / Build runs on every change") }]);
  });

  it("needs the Windows runner check for its trigger paths and for Windows scripts, and not otherwise", () => {
    expect(requiredPathScopedChecks({ policy: paperclip, changedFiles: ["server/src/app.ts", "docs/a.md"] })).toEqual([]);
    for (const file of ["packages/paperclip-runner/runner/src/lib.rs", "scripts/setup.ps1", ".github/scripts/check.mjs"]) {
      expect(requiredPathScopedChecks({ policy: paperclip, changedFiles: ["server/src/app.ts", file] })).toEqual(["Runner Rust (Windows x64)"]);
    }
    expect(requiredPathScopedChecks({ policy: paperclip, changedFiles: null })).toEqual(["Runner Rust (Windows x64)"]);
    const files = ["packages/paperclip-runner/runner/src/lib.rs"];
    expect(evaluate(PAPERCLIP_ORDINARY_PR, files))
      .toMatchObject([{ code: "required_check_skipped", detail: expect.stringContaining("Runner Rust (Windows x64) did not run") }]);
    expect(evaluate([...PAPERCLIP_ORDINARY_PR, check("Runner Rust (Windows x64)", "success")], files)).toEqual([]);
  });

  it("starts the Windows runner workflow for every path the gate needs it for (PR #41, STA-223)", () => {
    // PR #41 touched .github/scripts; the gate needed Windows evidence the
    // workflow's `paths:` trigger never started, so it could not merge.
    const workflow = readFileSync(new URL("../../../../.github/workflows/runner-windows.yml", import.meta.url), "utf8");
    const triggers = (event: string) => {
      const block = workflow.split(`\n  ${event}:\n`)[1]?.split(/\n  \S/)[0] ?? "";
      return [...block.matchAll(/^\s+- '?([^'\s]+)'?$/gm)].map(match => new RegExp(`^${match[1]!
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*")}$`));
    };
    const samples = [
      ".github/scripts/staple-ci-scope.mjs", ".github/scripts/tests/ci-plan.test.mjs", "setup.ps1", "scripts/dev/setup.ps1",
      "tools/a.psm1", "tools/a.psd1", "bin/run.cmd", "bin/run.bat", ".github/workflows/runner-windows.yml",
      "packages/paperclip-runner/runner/src/lib.rs", "packages/paperclip-runner/rust-toolchain.toml", "tests/runner-e2e/fixtures/a.json",
    ];
    for (const event of ["pull_request", "push"]) {
      const filters = triggers(event);
      expect(filters.length).toBeGreaterThan(0);
      for (const file of samples) {
        expect(requiredPathScopedChecks({ policy: paperclip, changedFiles: [file] })).toEqual(["Runner Rust (Windows x64)"]);
        expect(filters.some(filter => filter.test(file)), `${event} trigger misses ${file}`).toBe(true);
      }
      expect(filters.some(filter => filter.test("server/src/app.ts"))).toBe(false);
    }
  });

  it("accepts the label-only CI work benchmark jobs as skipped on a CI-file change (PR #41)", () => {
    const files = [".github/workflows/pr-trusted.yml", ".github/scripts/staple-ci-scope.mjs"];
    const benchmark = ["paired", "rust_prime", "rust_restore"].map(name => check(name, "skipped"));
    const windows = check("Runner Rust (Windows x64)", "success");
    expect(evaluate([...PAPERCLIP_ORDINARY_PR, windows, ...benchmark, workflow("CI work benchmark", "skipped")], files)).toEqual([]);
    // Labelled, they must still pass.
    expect(evaluate([...PAPERCLIP_ORDINARY_PR, windows, check("paired", "failure")], files))
      .toMatchObject([{ code: "ci_failed", detail: expect.stringContaining("paired (failure)") }]);
    expect(evaluate([...PAPERCLIP_ORDINARY_PR, ...benchmark], files))
      .toMatchObject([{ code: "required_check_skipped", detail: expect.stringContaining("Runner Rust (Windows x64) did not run") }]);
  });
});

describe("exact-head CI", () => {
  it("does not merge while slow CI is still running, and does not call it failed", () => {
    const reasons = evaluateHeadCi({
      headSha: HEAD, policy: facette, checksComplete: true, requiredChecks: [], changedFiles: ["docs/a.md"],
      checks: [check("shell", "success"), check("windows-native", null, "in_progress"), workflow("CI", null, "in_progress")],
    });
    expect(reasons).toMatchObject([{ code: "ci_pending" }]);
  });

  it("refuses absent, failed, cancelled or partially read CI", () => {
    const base = { headSha: HEAD, policy: facette, requiredChecks: [], changedFiles: ["docs/a.md"] };
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
    expect(evaluate([review({ reviewerModelFamilies: ["anthropic"] })])).toMatchObject([{ code: "review_not_independent", detail: expect.stringContaining("cross-model") }]);
    expect(evaluate([review({ writtenByReviewer: false })])).toMatchObject([{ code: "review_not_independent" }]);
  });

  it("decides cross-model by recorded model family, not adapter", () => {
    // Claude through pi_local is still Claude; Codex and Claude through one runner adapter differ.
    expect(modelFamily({ model: "anthropic/claude-sonnet-5-5", provider: "openrouter" })).toBe("anthropic");
    expect(modelFamily({ model: "gpt-6.1-sol", provider: "openai" })).toBe("openai");
    expect(modelFamily({ model: "some-router-model", provider: "openrouter" })).toBeNull();
    expect(evaluate([review({ reviewerModelFamilies: modelFamiliesFromRunUsage({ model: "anthropic/claude-sonnet-5-5", provider: "openrouter" }) })]))
      .toMatchObject([{ code: "review_not_independent", detail: expect.stringContaining("anthropic") }]);
    expect(evaluateReviewCoverage({ pullRequest: "ethanmonlux/facette#704", headSha: HEAD, deltaFor: () => ({ kind: "identical" }),
      author: { agentIds: ["runner-claude"], modelFamilies: modelFamiliesFromRunUsage({ model: "claude-opus-5-5", provider: "anthropic" }) },
      reviews: [review({ reviewerAgentId: "runner-codex", reviewerModelFamilies: modelFamiliesFromRunUsage({ model: "gpt-6.1-sol", provider: "openai" }) })] }))
      .toEqual([]);
  });

  it("fails closed when review or implementation provenance is missing", () => {
    expect(evaluate([review({ reviewerModelFamilies: [] })])).toMatchObject([{ code: "review_not_independent", detail: expect.stringContaining("recorded no model") }]);
    expect(evaluateReviewCoverage({ pullRequest: "ethanmonlux/facette#704", headSha: HEAD, deltaFor: () => ({ kind: "identical" }),
      author: { agentIds: ["claude-engineer"], modelFamilies: null }, reviews: [review()] }))
      .toMatchObject([{ code: "review_not_independent", detail: expect.stringContaining("no recorded model") }]);
    expect(evaluateReviewCoverage({ pullRequest: "ethanmonlux/facette#704", headSha: HEAD, deltaFor: () => ({ kind: "identical" }),
      author: { agentIds: null, modelFamilies: ["anthropic"] }, reviews: [review()] }))
      .toMatchObject([{ code: "review_not_independent", detail: expect.stringContaining("no recorded model provenance") }]);
  });

  it("refuses a reviewer that worked on the task, whatever its model now", () => {
    // STA-218: a previous implementer reviewing after a handoff is not independent.
    expect(evaluateReviewCoverage({ pullRequest: "ethanmonlux/facette#704", headSha: HEAD, deltaFor: () => ({ kind: "identical" }),
      author: { agentIds: ["claude-engineer", "codex-reviewer"], modelFamilies: ["anthropic", "openai"] }, reviews: [review()] }))
      .toMatchObject([{ code: "review_not_independent", detail: expect.stringContaining("worked on this task") }]);
  });

  it("reads every model a run recorded", () => {
    expect(modelFamiliesFromRunUsage({ model: "claude-opus-5-5", provider: "anthropic",
      usageByModel: [{ model: "claude-haiku-5-5" }, { model: "gpt-6.1-mini" }] })).toEqual(["anthropic", "openai"]);
    expect(modelFamiliesFromRunUsage({ provider: "openai" })).toEqual(["openai"]);
    expect(modelFamiliesFromRunUsage(null)).toEqual([]);
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
    ].join("\n"))).toEqual({ pullRequest: "ethanmonlux/facette#704", reviewedSha: HEAD, scope: "full", p0: 0, p1: 0, p2: ["FAC-901", "FAC-902"], sourceAuthorAgentIds: null });
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

