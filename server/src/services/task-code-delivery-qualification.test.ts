import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitRemoteAuthProvider } from "./git-credentials.js";
import { inspectTaskDirectory } from "./isolated-task-directory-snapshot.js";
import {
  codeDeliveryEvidence,
  describeCodeDeliveryQualification,
  githubPullRequestIdentity,
  githubRemoteIdentity,
  qualifyCodeDeliveryTaskDirectory,
} from "./task-code-delivery-qualification.js";

const REMOTE = "https://github.com/example/delivered.git";
const PULL_REQUEST = "https://github.com/example/delivered/pull/7";
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.com", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull };
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { env: GIT_ENV, encoding: "utf8" }).trim();

/** A task folder whose repo/ checkout pushed its only commit to a local
 * upstream that stands in for the GitHub origin. */
async function deliveredTaskFolder() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-code-delivery-")));
  directories.push(root);
  const upstream = path.join(root, "upstream.git");
  const task = path.join(root, "task");
  const checkout = path.join(task, "repo");
  await fs.mkdir(task);
  execFileSync("git", ["init", "-q", "--bare", upstream], { env: GIT_ENV });
  execFileSync("git", ["clone", "-q", upstream, checkout], { env: GIT_ENV, stdio: "ignore" });
  git(checkout, "symbolic-ref", "HEAD", "refs/heads/main");
  await fs.writeFile(path.join(checkout, "README.md"), "delivered\n");
  git(checkout, "add", "README.md");
  git(checkout, "commit", "-q", "-m", "Deliver fixture");
  git(checkout, "push", "-q", "origin", "HEAD:main");
  git(checkout, "remote", "set-url", "origin", REMOTE);
  await fs.writeFile(path.join(task, "report.md"), "final report\n");
  const head = git(checkout, "rev-parse", "HEAD");
  const resolveGitAuth: GitRemoteAuthProvider = async () => ({ env: {}, configArgs: ["-c", `url.${upstream}.insteadOf=${REMOTE}`],
    source: "managed_connection", secretName: null });
  const closeout = { kind: "code" as const, workspaceId: randomUUID(), lifecycleGeneration: 0, headSha: head, pullRequestUrl: PULL_REQUEST };
  return { task, checkout, head, closeout, resolveGitAuth };
}

describe("code delivery qualification", () => {
  it("reads only the GitHub owner and repository from remotes and pull request URLs", () => {
    expect(githubRemoteIdentity("https://github.com/Example/Delivered.git")).toBe("example/delivered");
    expect(githubRemoteIdentity("https://x-access-token:secret@github.com/example/delivered")).toBe("example/delivered");
    expect(githubRemoteIdentity("git@github.com:example/delivered.git")).toBe("example/delivered");
    expect(githubRemoteIdentity("ssh://git@github.com/example/delivered.git")).toBe("example/delivered");
    expect(githubRemoteIdentity("https://gitlab.com/example/delivered.git")).toBeNull();
    expect(githubRemoteIdentity("https://github.com/example/delivered/tree/main")).toBeNull();
    expect(githubPullRequestIdentity(PULL_REQUEST)).toBe("example/delivered");
    expect(githubPullRequestIdentity("https://github.com/example/delivered/issues/7")).toBeNull();
    expect(githubPullRequestIdentity("https://github.com/example/delivered/pull/0")).toBeNull();
  });

  it("separates nested checkouts from the outer files a restore point would save", async () => {
    const f = await deliveredTaskFolder();
    const before = await inspectTaskDirectory(f.task, { nestedRepositories: true });
    expect(before.repositories).toEqual(["repo"]);
    await fs.writeFile(path.join(f.checkout, "README.md"), "changed inside the checkout\n");
    expect((await inspectTaskDirectory(f.task, { nestedRepositories: true })).digest).toBe(before.digest);
    await expect(inspectTaskDirectory(f.task)).rejects.toThrow("nested_git_repository");
    await expect(inspectTaskDirectory(f.checkout, { nestedRepositories: true })).rejects.toThrow("nested_git_repository");
  });

  it("qualifies a clean, published checkout that contains the delivered head", async () => {
    const f = await deliveredTaskFolder();
    const qualified = await qualifyCodeDeliveryTaskDirectory(f.task, f.closeout, { resolveGitAuth: f.resolveGitAuth });
    expect(qualified.repositories).toEqual([{ path: "repo", repository: "example/delivered", head: f.head, containsDeliveredHead: true }]);
    expect(describeCodeDeliveryQualification(qualified)).toEqual([
      `repo/: github.com/example/delivered at ${f.head.slice(0, 12)} contains the delivered head; clean and every local commit is published upstream`,
      "2 outer task entries fit restore-point limits",
    ]);
  });

  it("keeps uncommitted and unpublished checkout work", async () => {
    const dirty = await deliveredTaskFolder();
    await fs.writeFile(path.join(dirty.checkout, "scratch.txt"), "unpublished\n");
    await expect(qualifyCodeDeliveryTaskDirectory(dirty.task, dirty.closeout, { resolveGitAuth: dirty.resolveGitAuth }))
      .rejects.toThrow("dirty_or_untracked_files");

    const unpushed = await deliveredTaskFolder();
    await fs.writeFile(path.join(unpushed.checkout, "later.txt"), "local only\n");
    git(unpushed.checkout, "add", "later.txt");
    git(unpushed.checkout, "commit", "-q", "-m", "Local follow-up");
    await expect(qualifyCodeDeliveryTaskDirectory(unpushed.task, unpushed.closeout, { resolveGitAuth: unpushed.resolveGitAuth }))
      .rejects.toThrow("unpushed_managed_checkout");
    expect(codeDeliveryEvidence("unpushed_managed_checkout")).toBe("every nested checkout commit published upstream");
  });

  it("requires the closeout's repository and head before contacting the upstream", async () => {
    const f = await deliveredTaskFolder();
    const offline: GitRemoteAuthProvider = async () => { throw new Error("must not contact the upstream"); };
    await expect(qualifyCodeDeliveryTaskDirectory(f.task, { ...f.closeout, pullRequestUrl: "https://github.com/example/other/pull/7" },
      { resolveGitAuth: offline })).rejects.toThrow("delivery_repository_mismatch");
    await expect(qualifyCodeDeliveryTaskDirectory(f.task, { ...f.closeout, headSha: "a".repeat(40) }, { resolveGitAuth: offline }))
      .rejects.toThrow("delivered_head_not_in_checkout");
    await expect(qualifyCodeDeliveryTaskDirectory(f.task, { ...f.closeout, pullRequestUrl: "https://example.com/pull/7" },
      { resolveGitAuth: offline })).rejects.toThrow("delivery_pull_request_unverifiable");
    await fs.rm(f.checkout, { recursive: true, force: true });
    await expect(qualifyCodeDeliveryTaskDirectory(f.task, f.closeout, { resolveGitAuth: offline })).rejects.toThrow("delivery_repository_missing");
  });
});
