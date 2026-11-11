import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionWorkspace } from "@paperclipai/shared";
import { inspectGitCloseReadiness } from "./execution-workspaces.js";
import { inspectTaskDirectory } from "./isolated-task-directory-snapshot.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

function workspace(cwd: string): ExecutionWorkspace {
  return {
    id: "workspace-nested",
    companyId: "company-nested",
    sourceIssueId: "issue-nested",
    providerType: "local_fs",
    providerRef: cwd,
    cwd,
    repoUrl: "https://github.com/example/repo.git",
    branchName: "main",
    baseRef: null,
    metadata: {},
  } as ExecutionWorkspace;
}

describe("nested task repository close readiness", () => {
  it("shows the actual repository and outer artifacts without qualifying the wrapper for removal", async () => {
    const outer = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-nested-close-"));
    directories.push(outer);
    const repo = path.join(outer, "repo");
    await fs.mkdir(repo);
    execFileSync("git", ["init", "-q", repo]);
    await fs.writeFile(path.join(outer, "evidence.txt"), "unpublished output");

    const result = await inspectGitCloseReadiness(workspace(outer));

    expect(result.git?.repoRoot).toBe(repo);
    expect(result.git?.workspacePath).toBe(repo);
    expect(result.statusInspectionSucceeded).toBe(false);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("repository is nested"),
      expect.stringContaining("1 outer task entry"),
    ]));
    await expect(inspectTaskDirectory(outer)).rejects.toThrow("nested_git_repository");
  });

  it("keeps a plain task directory distinct from a nested repository", async () => {
    const outer = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-plain-close-"));
    directories.push(outer);
    const result = await inspectGitCloseReadiness(workspace(outer));
    expect(result.git?.repoRoot).toBeNull();
    expect(result.statusInspectionSucceeded).toBe(true);
  });
});
