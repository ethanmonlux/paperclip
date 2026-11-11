import path from "node:path";
import type { IssueDeliveryCloseout } from "@paperclipai/shared";
import type { GitRemoteAuthProvider } from "./git-credentials.js";
import { assertReproducibleManagedCheckout, gitCacheCommand } from "./git-workspace-restoration.js";
import { inspectTaskDirectory, type TaskDirectorySnapshotLimits } from "./isolated-task-directory-snapshot.js";

type CodeCloseout = Extract<IssueDeliveryCloseout, { kind: "code" }>;

export type CodeDeliveryRepository = { path: string; repository: string; head: string; containsDeliveredHead: boolean };
export type CodeDeliveryQualification = { repositories: CodeDeliveryRepository[]; outerDigest: string; outerEntries: number };

function githubPath(value: string) {
  let url: URL;
  try { url = new URL(value.trim()); } catch { return null; }
  if (!["https:", "ssh:"].includes(url.protocol) || !["github.com", "www.github.com"].includes(url.hostname.toLowerCase())) return null;
  return url.pathname.replace(/^\/+|\/+$/g, "").split("/");
}

/** `owner/repo` for a GitHub origin. The remote can carry credentials, so
 * callers report only this identity and never the configured URL. */
export function githubRemoteIdentity(remote: string): string | null {
  const scp = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(remote.trim());
  const parts = scp ? [scp[1]!, scp[2]!] : githubPath(remote);
  const [owner, name] = parts ?? [];
  if (parts?.length !== 2 || !owner || !name) return null;
  return `${owner}/${name.replace(/\.git$/i, "")}`.toLowerCase();
}

export function githubPullRequestIdentity(url: string): string | null {
  const parts = githubPath(url);
  const [owner, name, kind, number] = parts ?? [];
  if (parts?.length !== 4 || !owner || !name || kind !== "pull" || !/^[1-9][0-9]*$/.test(number ?? "")) return null;
  return `${owner}/${name}`.toLowerCase();
}

/** Prove, without changing anything, that a code closeout is backed by the
 * task folder's nested checkout: it contains the delivered head, is clean, and
 * every local commit is published upstream. Files outside the checkout must
 * still fit the task-directory restore-point limits. */
export async function qualifyCodeDeliveryTaskDirectory(root: string, closeout: CodeCloseout, input: {
  resolveGitAuth: GitRemoteAuthProvider; limits?: TaskDirectorySnapshotLimits; signal?: AbortSignal;
}): Promise<CodeDeliveryQualification> {
  const { signal } = input;
  const delivered = githubPullRequestIdentity(closeout.pullRequestUrl);
  if (!delivered) throw new Error("delivery_pull_request_unverifiable");
  const outer = await inspectTaskDirectory(root, { limits: input.limits, signal, nestedRepositories: true });
  if (outer.repositories.length === 0) throw new Error("delivery_repository_missing");
  const checked: Array<CodeDeliveryRepository & { remote: string }> = [];
  // Read local identity first so a mismatched folder never reaches the network.
  for (const relative of outer.repositories) {
    const checkout = path.join(root, relative);
    const remotes = (await gitCacheCommand(checkout, ["config", "--local", "--null", "--get-all", "remote.origin.url"], signal)
      .catch(() => "")).split("\0").filter(Boolean);
    const repository = remotes.length === 1 ? githubRemoteIdentity(remotes[0]!) : null;
    if (!repository) throw new Error("nested_repository_remote_unproven");
    const head = (await gitCacheCommand(checkout, ["rev-parse", "--verify", "HEAD^{commit}"], signal)).trim();
    const containsDeliveredHead = repository === delivered && await gitCacheCommand(checkout,
      ["merge-base", "--is-ancestor", closeout.headSha.toLowerCase(), "HEAD"], signal).then(() => true, () => false);
    checked.push({ path: relative, repository, head, containsDeliveredHead, remote: remotes[0]! });
  }
  if (!checked.some(repository => repository.repository === delivered)) throw new Error("delivery_repository_mismatch");
  if (!checked.some(repository => repository.containsDeliveredHead)) throw new Error("delivered_head_not_in_checkout");
  for (const repository of checked) {
    await assertReproducibleManagedCheckout(path.join(root, repository.path), { repoUrl: repository.remote,
      resolveGitAuth: input.resolveGitAuth, signal });
  }
  return { repositories: checked.map(({ remote: _remote, ...repository }) => repository), outerDigest: outer.digest,
    outerEntries: outer.entries };
}

const EVIDENCE: Record<string, string> = {
  delivery_pull_request_unverifiable: "GitHub pull request URL in the code delivery closeout",
  delivery_repository_missing: "nested checkout of the delivered repository",
  nested_repository_remote_unproven: "one GitHub origin remote for every nested checkout",
  delivery_repository_mismatch: "nested checkout of the closeout pull request repository",
  delivered_head_not_in_checkout: "delivered head contained in the nested checkout",
  dirty_or_untracked_files: "committed and published nested checkout changes",
  unique_ignored_files: "published or checkpointed ignored files in the nested checkout",
  unpushed_managed_checkout: "every nested checkout commit published upstream",
  managed_checkout_upstream_unavailable: "reachable upstream repository for the nested checkout",
  task_directory_too_many_files: "outer task files within restore-point limits",
  task_directory_file_too_large: "outer task files within restore-point limits",
  task_directory_too_large: "outer task files within restore-point limits",
};

/** Evidence still needed after a failed code-delivery proof. */
export function codeDeliveryEvidence(reason: string) {
  return EVIDENCE[reason] ?? "nested checkout reproducible from its published upstream";
}

export function describeCodeDeliveryQualification(qualified: CodeDeliveryQualification) {
  return [
    ...qualified.repositories.map(repository => `${repository.path}/: github.com/${repository.repository} at ${repository.head.slice(0, 12)}`
      + `${repository.containsDeliveredHead ? " contains the delivered head" : ""}; clean and every local commit is published upstream`),
    `${qualified.outerEntries} outer task entries fit restore-point limits`,
  ];
}
