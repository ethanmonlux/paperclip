import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitRemoteAuthProvider } from "./git-credentials.js";
import {
  credentialFreeRemote,
  readTaskDirectoryRepositoryRecipe,
  restoreTaskDirectoryRepositories,
  taskDirectoryRepositoriesUnchanged,
  taskDirectoryRepositoryMatches,
  validateTaskDirectoryRepositoryRecipes,
} from "./task-directory-repositories.js";

const REMOTE = "https://github.com/example/delivered.git";
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.com", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull };
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { env: GIT_ENV, encoding: "utf8" }).trim();

async function publishedCheckout(origin = REMOTE) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-task-repositories-")));
  directories.push(root);
  const upstream = path.join(root, "upstream.git");
  const task = path.join(root, "task");
  const checkout = path.join(task, "nested", "repo");
  await fs.mkdir(path.dirname(checkout), { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", upstream], { env: GIT_ENV });
  execFileSync("git", ["clone", "-q", upstream, checkout], { env: GIT_ENV, stdio: "ignore" });
  git(checkout, "symbolic-ref", "HEAD", "refs/heads/feature/x");
  await fs.writeFile(path.join(checkout, "README.md"), "first\n");
  git(checkout, "add", "README.md");
  git(checkout, "commit", "-q", "-m", "First");
  await fs.writeFile(path.join(checkout, "README.md"), "delivered\n");
  git(checkout, "commit", "-q", "-am", "Deliver");
  git(checkout, "push", "-q", "-u", "origin", "HEAD:feature/x");
  git(checkout, "remote", "set-url", "origin", origin);
  const resolveGitAuth: GitRemoteAuthProvider = async url => ({ env: {}, configArgs: ["-c", `url.${upstream}.insteadOf=${url}`],
    source: "managed_connection", secretName: null });
  return { root, task, checkout, upstream, resolveGitAuth, head: git(checkout, "rev-parse", "HEAD") };
}

describe("task directory repository recipes", () => {
  it("drops credentials from a recorded origin", () => {
    expect(credentialFreeRemote("https://x-access-token:secret@github.com/example/delivered.git")).toBe(REMOTE);
    expect(credentialFreeRemote("ssh://git:secret@github.com/example/delivered.git")).toBe("ssh://git@github.com/example/delivered.git");
    expect(credentialFreeRemote("git@github.com:example/delivered.git")).toBe("git@github.com:example/delivered.git");
  });

  it("records the checked-out branch, upstream and head without credentials", async () => {
    const f = await publishedCheckout("https://x-access-token:secret@github.com/example/delivered.git");
    const recipe = await readTaskDirectoryRepositoryRecipe(f.task, "nested/repo");
    expect(recipe).toEqual({ path: "nested/repo", repository: "example/delivered", remoteUrl: REMOTE, head: f.head,
      branch: "feature/x", upstream: "refs/heads/feature/x", stateDigest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(JSON.stringify(recipe)).not.toContain("secret");
  });

  it("notices any local change after the recipe was read", async () => {
    const f = await publishedCheckout();
    const recipe = await readTaskDirectoryRepositoryRecipe(f.task, "nested/repo");
    expect(await taskDirectoryRepositoriesUnchanged(f.task, [recipe])).toBe(true);
    await fs.writeFile(path.join(f.checkout, "ignored.log"), "scratch\n");
    expect(await taskDirectoryRepositoriesUnchanged(f.task, [recipe])).toBe(false);
    await fs.rm(path.join(f.checkout, "ignored.log"));
    git(f.checkout, "branch", "side");
    expect(await taskDirectoryRepositoriesUnchanged(f.task, [recipe])).toBe(false);
  });

  it("rejects malformed or unsafe recipes", async () => {
    const f = await publishedCheckout();
    const recipe = await readTaskDirectoryRepositoryRecipe(f.task, "nested/repo");
    for (const bad of [
      [],
      [{ ...recipe, path: "../escape" }],
      [{ ...recipe, path: "nested/repo/.git" }],
      [recipe, { ...recipe, path: "nested/repo/inner" }],
      [{ ...recipe, remoteUrl: "https://x-access-token:secret@github.com/example/delivered.git" }],
      [{ ...recipe, remoteUrl: "https://gitlab.com/example/delivered.git", repository: "example/delivered" }],
      [{ ...recipe, repository: "example/other" }],
      [{ ...recipe, head: "HEAD" }],
      [{ ...recipe, branch: "-c" }],
      [{ ...recipe, branch: null }],
      Array.from({ length: 17 }, (_, index) => ({ ...recipe, path: `repo-${index}` })),
    ]) {
      expect(() => validateTaskDirectoryRepositoryRecipes(bad), JSON.stringify(bad).slice(0, 120)).toThrow("invalid_repository_recipe");
    }
  });

  it("rebuilds the exact checkout from its origin", async () => {
    const f = await publishedCheckout();
    const recipe = await readTaskDirectoryRepositoryRecipe(f.task, "nested/repo");
    const target = path.join(f.root, "restored");
    await fs.mkdir(path.join(target, "nested", "repo"), { recursive: true });
    await restoreTaskDirectoryRepositories(target, [recipe], { resolveGitAuth: f.resolveGitAuth });
    const restored = path.join(target, "nested", "repo");
    expect(git(restored, "rev-parse", "HEAD")).toBe(f.head);
    expect(git(restored, "symbolic-ref", "HEAD")).toBe("refs/heads/feature/x");
    expect(git(restored, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/feature/x");
    expect(git(restored, "remote", "get-url", "origin")).toBe(REMOTE);
    expect(git(restored, "rev-list", "--count", "HEAD")).toBe("2");
    expect(git(restored, "status", "--porcelain")).toBe("");
    expect(await fs.readFile(path.join(restored, "README.md"), "utf8")).toBe("delivered\n");
    expect(await taskDirectoryRepositoryMatches(target, recipe)).toBe(true);
  });

  it("restores a detached head whose branch was deleted upstream", async () => {
    const f = await publishedCheckout();
    git(f.checkout, "checkout", "-q", "--detach");
    const recipe = await readTaskDirectoryRepositoryRecipe(f.task, "nested/repo");
    expect(recipe).toMatchObject({ branch: null, upstream: null });
    // The pull request ref keeps the commit after the branch is gone.
    execFileSync("git", ["-C", f.upstream, "update-ref", "refs/pull/7/head", f.head], { env: GIT_ENV });
    execFileSync("git", ["-C", f.upstream, "update-ref", "-d", "refs/heads/feature/x"], { env: GIT_ENV });
    execFileSync("git", ["-C", f.upstream, "config", "uploadpack.allowAnySHA1InWant", "true"], { env: GIT_ENV });
    const target = path.join(f.root, "restored");
    await fs.mkdir(path.join(target, "nested", "repo"), { recursive: true });
    await restoreTaskDirectoryRepositories(target, [recipe], { resolveGitAuth: f.resolveGitAuth });
    const restored = path.join(target, "nested", "repo");
    expect(git(restored, "rev-parse", "HEAD")).toBe(f.head);
    expect(await taskDirectoryRepositoryMatches(target, recipe)).toBe(true);
  });

  it("fails without exposing git output when the origin is unavailable", async () => {
    const f = await publishedCheckout();
    const recipe = await readTaskDirectoryRepositoryRecipe(f.task, "nested/repo");
    const target = path.join(f.root, "restored");
    await fs.mkdir(path.join(target, "nested", "repo"), { recursive: true });
    const unavailable: GitRemoteAuthProvider = async () => ({ env: {}, source: "managed_connection", secretName: null,
      configArgs: ["-c", `url.${path.join(f.root, "missing.git")}.insteadOf=${REMOTE}`] });
    const failure = await restoreTaskDirectoryRepositories(target, [recipe], { resolveGitAuth: unavailable }).catch(error => error as Error);
    expect(failure.message).toBe("The task directory could not be restored: repository_restore_failed");
    expect(failure.message).not.toContain(f.root);
  });
});
