import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { GitRemoteAuthProvider } from "./git-credentials.js";
import { gitCacheCommand } from "./git-workspace-restoration.js";
import { TaskDirectoryRestoreFailure } from "./isolated-task-directory-snapshot.js";
import { githubRemoteIdentity } from "./task-code-delivery-qualification.js";

const execFile = promisify(execFileCallback);
const SHA = /^[a-f0-9]{40}$/;
const FETCH_TIMEOUT_MS = 10 * 60 * 1000;
export const MAX_TASK_DIRECTORY_REPOSITORIES = 16;

/** How reopening rebuilds one nested checkout of a retired task folder. The
 * publication proof established that every local commit is upstream, so the
 * checkout is recreated from its origin rather than saved. */
export type TaskDirectoryRepositoryRecipe = {
  path: string;
  /** GitHub `owner/repo`. */
  repository: string;
  /** Origin URL without any embedded credentials. */
  remoteUrl: string;
  head: string;
  /** Checked-out branch, or null for a detached HEAD. */
  branch: string | null;
  /** `branch.<name>.merge` when the branch tracked `origin`. */
  upstream: string | null;
  /** Local refs, reflogs, config and status the proof covered. Removal
   * requires the same state; it is never needed to restore. */
  stateDigest: string;
};

/** The origin URL a restored checkout uses. Inline credentials are dropped;
 * reopening authenticates through the task's current repository access. */
export function credentialFreeRemote(remote: string) {
  const value = remote.trim();
  if (/^git@github\.com:/i.test(value)) return value;
  const url = new URL(value);
  if (url.protocol === "ssh:") url.password = "";
  else { url.username = ""; url.password = ""; }
  return url.toString();
}

async function git(cwd: string, args: string[], signal?: AbortSignal) {
  return gitCacheCommand(cwd, args, signal);
}

/** Digest of the local state a publication proof read. Any later commit,
 * branch, reflog entry, config or working-tree change alters it. */
export async function repositoryStateDigest(checkout: string, signal?: AbortSignal) {
  const parts = [
    await git(checkout, ["rev-parse", "--verify", "HEAD^{commit}"], signal),
    await git(checkout, ["symbolic-ref", "--quiet", "HEAD"], signal).catch(() => ""),
    await git(checkout, ["for-each-ref", "--format=%(objectname) %(refname)"], signal),
    await git(checkout, ["reflog", "show", "--all", "--format=%H %gD"], signal).catch(() => ""),
    await git(checkout, ["config", "--local", "--list"], signal),
    await git(checkout, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored", "-z"], signal),
  ];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export async function readTaskDirectoryRepositoryRecipe(root: string, relative: string, signal?: AbortSignal): Promise<TaskDirectoryRepositoryRecipe> {
  const checkout = path.join(root, relative);
  const remotes = (await git(checkout, ["config", "--local", "--null", "--get-all", "remote.origin.url"], signal).catch(() => ""))
    .split("\0").filter(Boolean);
  const repository = remotes.length === 1 ? githubRemoteIdentity(remotes[0]!) : null;
  if (!repository) throw new Error("nested_repository_remote_unproven");
  const head = (await git(checkout, ["rev-parse", "--verify", "HEAD^{commit}"], signal)).trim();
  const symbolic = (await git(checkout, ["symbolic-ref", "--quiet", "HEAD"], signal).catch(() => "")).trim();
  const branch = symbolic.startsWith("refs/heads/") ? symbolic.slice("refs/heads/".length) : null;
  if (symbolic && !branch) throw new Error("unsupported_managed_checkout_refs");
  let upstream: string | null = null;
  if (branch) {
    const remote = (await git(checkout, ["config", "--local", "--get", `branch.${branch}.remote`], signal).catch(() => "")).trim();
    const merge = (await git(checkout, ["config", "--local", "--get", `branch.${branch}.merge`], signal).catch(() => "")).trim();
    if (remote === "origin" && merge) upstream = merge;
  }
  const recipe = { path: relative, repository, remoteUrl: credentialFreeRemote(remotes[0]!), head, branch, upstream,
    stateDigest: await repositoryStateDigest(checkout, signal) };
  try { validateTaskDirectoryRepositoryRecipes([recipe]); }
  catch { throw new Error("unsupported_nested_checkout"); }
  return recipe;
}

function validRelativePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\0") && !value.startsWith("/")
    && value.split("/").every(part => part.length > 0 && part !== "." && part !== ".." && part !== ".git");
}

const validRef = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 255
  && /^[A-Za-z0-9._/-]+$/.test(value) && !value.startsWith("-") && !value.includes("..") && !value.startsWith("/")
  && !value.endsWith("/") && !value.endsWith(".lock") && !value.includes("//");

/** Recipes come from workspace metadata; never trust their shape. */
export function validateTaskDirectoryRepositoryRecipes(value: unknown): TaskDirectoryRepositoryRecipe[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TASK_DIRECTORY_REPOSITORIES) {
    throw new TaskDirectoryRestoreFailure("invalid_repository_recipe");
  }
  const paths = new Set<string>();
  for (const recipe of value as TaskDirectoryRepositoryRecipe[]) {
    let identity: string | null = null;
    try { identity = recipe && typeof recipe.remoteUrl === "string" && recipe.remoteUrl === credentialFreeRemote(recipe.remoteUrl)
      ? githubRemoteIdentity(recipe.remoteUrl) : null; } catch { identity = null; }
    if (!recipe || typeof recipe !== "object" || !validRelativePath(recipe.path) || paths.has(recipe.path)
      || identity === null || identity !== recipe.repository || !SHA.test(recipe.head) || !/^[0-9a-f]{64}$/.test(recipe.stateDigest)
      || (recipe.branch !== null && !validRef(recipe.branch))
      || (recipe.upstream !== null && (!validRef(recipe.upstream) || !recipe.upstream.startsWith("refs/heads/") || recipe.branch === null))) {
      throw new TaskDirectoryRestoreFailure("invalid_repository_recipe");
    }
    paths.add(recipe.path);
  }
  // One checkout cannot sit inside another: the folder walk stops at the first.
  for (const candidate of paths) {
    if ([...paths].some(other => other !== candidate && candidate.startsWith(`${other}/`))) {
      throw new TaskDirectoryRestoreFailure("invalid_repository_recipe");
    }
  }
  return value as TaskDirectoryRepositoryRecipe[];
}

/** Under the retention locks, the checkouts must still be exactly what the
 * publication proof covered. This check is local and never contacts a remote. */
export async function taskDirectoryRepositoriesUnchanged(root: string, recipes: TaskDirectoryRepositoryRecipe[], signal?: AbortSignal) {
  for (const recipe of recipes) {
    const digest = await repositoryStateDigest(path.join(root, recipe.path), signal).catch(() => null);
    if (digest !== recipe.stateDigest) return false;
  }
  return true;
}

/** A restored checkout matches its recipe: same commit, branch, upstream and
 * origin, with a clean working tree. */
export async function taskDirectoryRepositoryMatches(root: string, recipe: TaskDirectoryRepositoryRecipe, signal?: AbortSignal) {
  const checkout = path.join(root, recipe.path);
  try {
    if ((await git(checkout, ["rev-parse", "--show-toplevel"], signal)).trim() !== checkout) return false;
    if ((await git(checkout, ["rev-parse", "--verify", "HEAD^{commit}"], signal)).trim() !== recipe.head) return false;
    const symbolic = (await git(checkout, ["symbolic-ref", "--quiet", "HEAD"], signal).catch(() => "")).trim();
    if (symbolic !== (recipe.branch ? `refs/heads/${recipe.branch}` : "")) return false;
    if (await git(checkout, ["config", "--local", "--null", "--get-all", "remote.origin.url"], signal) !== `${recipe.remoteUrl}\0`) return false;
    if (recipe.branch) {
      const merge = (await git(checkout, ["config", "--local", "--get", `branch.${recipe.branch}.merge`], signal).catch(() => "")).trim();
      if ((merge || null) !== recipe.upstream) return false;
    }
    return (await git(checkout, ["status", "--porcelain=v1", "--untracked-files=all", "-z"], signal)).length === 0;
  } catch {
    return false;
  }
}

/** Rebuild each checkout inside a staging folder from its origin. This is the
 * only task-folder step that needs publication access. */
export async function restoreTaskDirectoryRepositories(root: string, recipes: TaskDirectoryRepositoryRecipe[], input: {
  resolveGitAuth: GitRemoteAuthProvider; signal?: AbortSignal;
}) {
  validateTaskDirectoryRepositoryRecipes(recipes);
  for (const recipe of recipes) {
    input.signal?.throwIfAborted();
    const checkout = path.join(root, recipe.path);
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull };
    const run = (args: string[], extra: { env?: Record<string, string>; timeout?: number } = {}) => execFile("git", args, {
      cwd: os.tmpdir(), signal: input.signal, timeout: extra.timeout ?? 60_000, maxBuffer: 16 * 1024 * 1024, env: { ...env, ...extra.env } });
    try {
      await run(["init", "--quiet", checkout]);
      await run(["-C", checkout, "remote", "add", "origin", recipe.remoteUrl]);
      const auth = await input.resolveGitAuth(recipe.remoteUrl);
      // Mirror a clone (branches and tags), and ask for the exact head in case
      // its branch was deleted upstream after the pull request merged.
      await run([...auth?.configArgs ?? [], "-C", checkout, "fetch", "--quiet", "--no-recurse-submodules", "origin",
        "+refs/heads/*:refs/remotes/origin/*", "+refs/tags/*:refs/tags/*", recipe.head],
      { env: auth?.env, timeout: FETCH_TIMEOUT_MS });
      await run(["-C", checkout, "cat-file", "-e", `${recipe.head}^{commit}`]);
      if (recipe.branch) {
        await run(["-C", checkout, "checkout", "--quiet", "-B", recipe.branch, recipe.head]);
        if (recipe.upstream) {
          await run(["-C", checkout, "config", `branch.${recipe.branch}.remote`, "origin"]);
          await run(["-C", checkout, "config", `branch.${recipe.branch}.merge`, recipe.upstream]);
        }
      } else {
        await run(["-C", checkout, "checkout", "--quiet", "--detach", recipe.head]);
      }
    } catch (error) {
      input.signal?.throwIfAborted();
      // Git output can carry host paths or remote URLs; keep only the outcome.
      const failure = new TaskDirectoryRestoreFailure("repository_restore_failed");
      (failure as Error & { cause?: unknown }).cause = error;
      throw failure;
    }
    if (!await taskDirectoryRepositoryMatches(root, recipe, input.signal)) {
      throw new TaskDirectoryRestoreFailure("restored_repository_mismatch");
    }
  }
}
