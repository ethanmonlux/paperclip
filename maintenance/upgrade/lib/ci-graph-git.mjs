import { spawnSync } from "node:child_process";
import { WORKFLOW_FILE, buildCiGraph } from "./ci-graph.mjs";

function git(repo, args) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

/**
 * Every entry directly in `rev`'s .github/workflows/, with its mode and exact
 * object id; workflow files also carry their text. Null if `rev` is unavailable.
 */
export function workflowsAt(repo, rev) {
  const listing = git(repo, ["ls-tree", "-z", `${rev}^{commit}`, "--", ".github/workflows/"]);
  if (listing === null) return null;
  return listing.split("\0").filter(Boolean).map((line) => {
    const [meta, file] = line.split("\t");
    const [mode, type, blob] = meta.split(" ");
    const text = type === "blob" && WORKFLOW_FILE.test(file) ? git(repo, ["cat-file", "blob", blob]) : undefined;
    return { path: file, mode, blob, ...(text === undefined ? {} : { text }) };
  });
}

/**
 * Regenerate the expected CI graph from local Git objects: pull_request
 * workflows from the candidate commit, pull_request_target workflows from the
 * base-context branch, reusable workflows from their pinned commit.
 */
export function ciGraphFromGit(repo, { candidate, baseContext }) {
  const head = workflowsAt(repo, candidate);
  if (!head) return { unsupported: `candidate ${candidate} is not available locally` };
  const base = workflowsAt(repo, baseContext);
  if (!base) return { unsupported: `base context ${baseContext} is not available locally` };
  const resolveCall = (_repository, sha, file) => {
    const blob = git(repo, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}:${file}`])?.trim();
    return blob ? { blob, text: git(repo, ["cat-file", "blob", blob]) } : null;
  };
  return buildCiGraph({ head, base, baseContext, resolveCall });
}
