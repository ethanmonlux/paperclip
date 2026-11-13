import { describe, expect, it, vi } from "vitest";
import { createMergeGateGitHub } from "./github.js";

describe("merge gate GitHub candidate identity", () => {
  it("retains exact source, workflow path and check-suite identity from GitHub", async () => {
    const headSha = "a".repeat(40);
    const fetchImpl = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("/check-runs")
      ? { total_count: 1, check_runs: [{ id: 111, name: "candidate", status: "completed", conclusion: "success", head_sha: headSha, check_suite: { id: 91 },
        started_at: "2026-11-11T12:01:00Z", completed_at: "2026-11-11T12:30:00Z" }] }
      : { total_count: 1, workflow_runs: [{ id: 1234, name: "Internal Windows Candidate", status: "completed", conclusion: "success",
        head_sha: headSha, check_suite_id: 91, path: ".github/workflows/internal-windows.yml@refs/heads/finished-candidate",
        run_attempt: 2, created_at: "2026-11-11T11:00:00Z", run_started_at: "2026-11-11T12:00:00Z" }] })));
    const github = createMergeGateGitHub({ repo: "ethanmonlux/facette", token: "test", fetchImpl });
    expect(await github.checks(headSha)).toEqual({ complete: true, checks: [
      { kind: "check_run", name: "candidate", status: "completed", conclusion: "success", headSha, checkSuiteId: 91, checkRunId: 111,
        startedAt: "2026-11-11T12:01:00Z", completedAt: "2026-11-11T12:30:00Z" },
      { kind: "workflow_run", name: "Internal Windows Candidate", status: "completed", conclusion: "success", headSha, checkSuiteId: 91,
        runId: 1234, workflowPath: ".github/workflows/internal-windows.yml", runAttempt: 2, createdAt: "2026-11-11T11:00:00Z",
        startedAt: "2026-11-11T12:00:00Z" },
    ] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps a renamed file's previous name", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([
      { filename: "docs/Face.tsx", previous_filename: "shell/faces/x4/Face.tsx", status: "renamed", sha: "b1" },
      { filename: "docs/a.md", status: "modified", sha: "b2", patch: "@@" },
    ])));
    const github = createMergeGateGitHub({ repo: "ethanmonlux/facette", token: "test", fetchImpl });
    expect(await github.pullRequestFiles(704)).toEqual([
      { filename: "docs/Face.tsx", previousFilename: "shell/faces/x4/Face.tsx", status: "renamed", blobSha: "b1", patch: null },
      { filename: "docs/a.md", previousFilename: null, status: "modified", blobSha: "b2", patch: "@@" },
    ]);
  });
});
