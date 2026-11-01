import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

function git(repo, args) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

/**
 * Paths a commit changed against its first parent, from local Git objects.
 * Unavailable when the commit or its first parent is absent, or the commit is
 * a shallow boundary: there its diff would list the whole tree.
 */
export function commitFilesFromGit(repo, sha) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? "")) return { unavailable: "not a full commit SHA" };
  if (git(repo, ["cat-file", "-e", `${sha}^{commit}`]) === null) return { unavailable: "commit not available locally" };
  const shallowPath = git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "shallow"])?.trim();
  if (!shallowPath) return { unavailable: "shallow state unreadable" };
  if (existsSync(shallowPath) && readFileSync(shallowPath, "utf8").split("\n").includes(sha)) return { unavailable: "shallow boundary commit" };
  const parents = git(repo, ["rev-list", "--parents", "-n", "1", sha])?.trim().split(" ").slice(1) ?? [];
  if (parents.length === 0) return { unavailable: "no parent available" };
  if (git(repo, ["cat-file", "-e", `${parents[0]}^{commit}`]) === null) return { unavailable: `first parent ${parents[0]} not available` };
  const listing = git(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", parents[0], sha]);
  if (listing === null) return { unavailable: "diff unavailable" };
  return { files: listing.split("\0").filter(Boolean) };
}
