import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { materializeManagedProjectWorkspace, ensureManagedRepositoriesIgnored } from "../services/managed-repository-checkout.js";

const execFile = promisify(execFileCallback);
const directories: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "paperclip-repository-publication-"));
  directories.push(root);
  const source = path.join(root, "source");
  await mkdir(source);
  await execFile("git", ["init", "--initial-branch=main", source]);
  await writeFile(path.join(source, "source.txt"), "initial\n");
  await execFile("git", ["-C", source, "add", "."]);
  await execFile("git", ["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "initial"]);
  return { root, source, target: path.join(root, "target") };
}
describe("atomic managed repository publication", () => {
  it("keeps managed repositories separate without requiring Git or touching an ancestor", async () => {
    const { source, target } = await fixture();
    await mkdir(target);
    await expect(ensureManagedRepositoriesIgnored(target)).resolves.toBeUndefined();
    const nestedPlainRoot = path.join(source, "plain-task");
    await mkdir(nestedPlainRoot);
    const original = await readFile(path.join(source, ".git", "info", "exclude"), "utf8");
    await ensureManagedRepositoriesIgnored(nestedPlainRoot);
    expect(await readFile(path.join(source, ".git", "info", "exclude"), "utf8")).toBe(original);
    await ensureManagedRepositoriesIgnored(source);
    expect(await readFile(path.join(source, ".git", "info", "exclude"), "utf8")).toContain("/.paperclip-repositories/");
  });
  it("allows a declared plain task directory with inert Git metadata without changing its files", async () => {
    const { target } = await fixture();
    await mkdir(path.join(target, ".git", "info"), { recursive: true });
    const file = path.join(target, ".git", "info", "exclude");
    await writeFile(file, "/.paperclip-repositories/\n");
    await expect(ensureManagedRepositoriesIgnored(target, { plainTaskDirectory: true })).resolves.toBeUndefined();
    expect(await readFile(file, "utf8")).toBe("/.paperclip-repositories/\n");
    await expect(ensureManagedRepositoriesIgnored(target)).rejects.toThrow("not a git repository");
  });
  // Git chooses its missing-repository wording by where discovery stopped, not
  // by anything the caller configured: a task directory under a mount point
  // reports the filesystem-boundary form. Both forms must honor the declared
  // plain directory, and no other Git failure may be swallowed as one.
  it.each([
    { label: "exhausted ancestor chain", plain: true,
      stderr: "fatal: not a git repository (or any of the parent directories): .git\n" },
    { label: "filesystem boundary", plain: true,
      stderr: "fatal: not a git repository (or any parent up to mount point /)\nStopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).\n" },
    { label: "named inert metadata", plain: false, stderr: "fatal: not a git repository: '/task/.git'\n" },
    { label: "permission denied", plain: false, stderr: "fatal: cannot open .git: Permission denied\n" },
    { label: "dubious ownership", plain: false,
      stderr: "fatal: detected dubious ownership in repository at '/task'\n" },
  ])("honors a declared plain task directory only for a stated missing repository: $label", async ({ stderr, plain }) => {
    const { root, target } = await fixture();
    await mkdir(path.join(target, ".git", "info"), { recursive: true });
    const file = path.join(target, ".git", "info", "exclude");
    await writeFile(file, "/.paperclip-repositories/\n");
    const bin = path.join(root, "stub-bin");
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, "git"), `#!/bin/sh\nprintf '%s' '${stderr}' >&2\nexit 128\n`, { mode: 0o755 });
    vi.stubEnv("PATH", bin);
    const ignored = ensureManagedRepositoriesIgnored(target, { plainTaskDirectory: true });
    if (plain) await expect(ignored).resolves.toBeUndefined();
    else await expect(ignored).rejects.toMatchObject({ code: 128 });
    expect(await readFile(file, "utf8")).toBe("/.paperclip-repositories/\n");
  });
  it("still excludes managed repositories when a task directory contains a real checkout", async () => {
    const { source } = await fixture();
    await ensureManagedRepositoriesIgnored(source, { plainTaskDirectory: true });
    expect(await readFile(path.join(source, ".git", "info", "exclude"), "utf8")).toContain("/.paperclip-repositories/");
  });
  it("retains unexpected Git errors for declared plain task directories", async () => {
    const { root, target } = await fixture();
    await mkdir(path.join(target, ".git"), { recursive: true });
    vi.stubEnv("PATH", path.join(root, "missing-git"));
    await expect(ensureManagedRepositoriesIgnored(target, { plainTaskDirectory: true })).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects linked Git metadata even for a declared plain task directory", async () => {
    const { source, target } = await fixture();
    await mkdir(target);
    await symlink(path.join(source, ".git"), path.join(target, ".git"), "dir");
    const original = await readFile(path.join(source, ".git", "info", "exclude"), "utf8");
    await expect(ensureManagedRepositoriesIgnored(target, { plainTaskDirectory: true })).rejects.toThrow("must not be a symlink");
    expect(await readFile(path.join(source, ".git", "info", "exclude"), "utf8")).toBe(original);
  });
  it("writes the pinned receipt inside the clone before making it visible", async () => {
    const { source, target } = await fixture();
    const result = await materializeManagedProjectWorkspace(target, { repoUrl: "https://github.com/test/source", localSource: source, beforePublish: async clone => {
      expect(await stat(target).catch(() => null)).toBeNull();
      const commit = (await execFile("git", ["-C", clone, "rev-parse", "HEAD"])).stdout.trim();
      await writeFile(path.join(clone, ".git", "paperclip-workspace-owner.json"), JSON.stringify({ repositoryId: "receipt", pinnedCommit: commit }));
    } });
    expect(result.warning).toBeNull();
    expect(JSON.parse(await readFile(path.join(target, ".git", "paperclip-workspace-owner.json"), "utf8"))).toMatchObject({ repositoryId: "receipt", pinnedCommit: expect.stringMatching(/^[a-f0-9]{40}$/) });
    expect(await readFile(path.join(target, "source.txt"), "utf8")).toBe("initial\n");
  });
  it("authorizes the empty staging root before copying any source bytes", async () => {
    const { root, source, target } = await fixture();
    let stagingChecked = false;
    await expect(materializeManagedProjectWorkspace(target, {
      repoUrl: source,
      beforeCopy: async staging => {
        expect(await readdir(staging)).toEqual([]);
        expect(await stat(target).catch(() => null)).toBeNull();
        stagingChecked = true;
        throw new Error("Private staging source denied");
      },
    })).rejects.toThrow("Private staging source denied");
    expect(stagingChecked).toBe(true);
    expect(await stat(target).catch(() => null)).toBeNull();
    expect((await readdir(root)).filter(name => name.startsWith("target.clone-"))).toEqual([]);
    expect(await readFile(path.join(source, "source.txt"), "utf8")).toBe("initial\n");
  });
  it("does not publish an incomplete checkout when its receipt cannot be committed", async () => {
    const { root, source, target } = await fixture();
    await expect(materializeManagedProjectWorkspace(target, { repoUrl: "https://github.com/test/source", localSource: source, beforePublish: async () => { throw new Error("receipt failed"); } })).rejects.toThrow(/receipt failed/);
    expect(await stat(target).catch(() => null)).toBeNull();
    expect((await readdir(root)).filter(name => name.startsWith("target.clone-"))).toEqual([]);
    expect(await readFile(path.join(source, "source.txt"), "utf8")).toBe("initial\n");
  });
});
