import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  activityLog,
  assets,
  agents,
  companies,
  createDb,
  environmentLeases,
  executionWorkspaceRestorePoints,
  executionWorkspaces,
  heartbeatRuns,
  issueComments,
  issueAttachments,
  issueWorkProducts,
  issueRecoveryActions,
  issues,
  nativeRunFinalizations,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import { materializeIsolatedTaskDirectory } from "../services/isolated-task-directory.js";
import {
  expireIsolatedTaskDirectory,
  inspectIsolatedTaskDirectoryFolders,
  readTaskDirectoryRetention,
  sweepIsolatedTaskDirectories,
  TASK_DIRECTORY_RESTORE_POINT_EXPIRED_WARNING,
} from "../services/isolated-task-directory-retention.js";
import { markGitRestorePointExpired } from "../services/git-restore-point-storage.js";
import { gitRestorePointRetentionService } from "../services/git-restore-point-ledger.js";
import { getStorageService } from "../storage/index.js";
import type { GitRemoteAuthProvider } from "../services/git-credentials.js";

// Reopen and live sweeps resolve repository access through the task's
// provider; route every fixture GitHub origin to its local upstream instead.
const gitFixture = vi.hoisted(() => ({ upstreams: new Map<string, string>(), calls: 0,
  beforeFetch: null as (() => Promise<void>) | null }));
vi.mock("../services/git-credentials.js", async importOriginal => ({
  ...await importOriginal<typeof import("../services/git-credentials.js")>(),
  createIssueGitRemoteAuthProvider: () => async () => {
    gitFixture.calls += 1;
    await gitFixture.beforeFetch?.();
    return { env: {}, source: "managed_connection" as const, secretName: null,
      configArgs: [...gitFixture.upstreams].flatMap(([remote, upstream]) => ["-c", `url.${upstream}.insteadOf=${remote}`]) };
  },
}));

const DAY_MS = 24 * 60 * 60 * 1000;
const DELIVERED_REMOTE = "https://github.com/example/delivered.git";
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.com", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { env: GIT_ENV, encoding: "utf8" }).trim();
const exists = (target: string) => fs.lstat(target).then(() => true, () => false);

async function age(target: string, at: Date) {
  const stat = await fs.lstat(target);
  if (stat.isDirectory()) for (const name of await fs.readdir(target)) await age(path.join(target, name), at);
  await (stat.isSymbolicLink() ? fs.lutimes(target, at, at) : fs.utimes(target, at, at));
}

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;
describeEmbeddedPostgres("isolated task directory retention", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let root: string;
  let outside: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const previousInstance = process.env.PAPERCLIP_INSTANCE_ID;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("isolated-task-directory-retention-");
    db = createDb(database.connectionString);
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-task-directory-retention-")));
    process.env.PAPERCLIP_HOME = path.join(root, "home");
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "31".repeat(32));
    outside = path.join(root, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "keep.txt"), "outside\n");
  });
  afterEach(async () => {
    await db.delete(executionWorkspaceRestorePoints);
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
    await fs.rm(path.join(root, "home", "instances", "default", "isolated-workspaces"), { recursive: true, force: true });
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    if (previousInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID; else process.env.PAPERCLIP_INSTANCE_ID = previousInstance;
    await db.$client.end({ timeout: 1 }); await database.cleanup(); await fs.rm(root, { recursive: true, force: true });
  });

  const settings = { dryRun: false, terminalDelayMs: 3 * DAY_MS, orphanGraceMs: 7 * DAY_MS };
  const restorePoints = (overrides: Partial<{ keyDurable: boolean }> = {}) => ({ storage: getStorageService(), terminalDelayMs: 3 * DAY_MS, keyDurable: true, ...overrides });

  async function fixture(options: { closedDaysAgo?: number | null; mode?: string; status?: string } = {}) {
    const companyId = randomUUID(), issueId = randomUUID(), workspaceId = randomUUID(), agentId = randomUUID();
    const closedDaysAgo = options.closedDaysAgo === undefined ? 4 : options.closedDaysAgo;
    await db.insert(companies).values({ id: companyId, name: "Task directory fixture", issuePrefix: `TD${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture agent" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Finished task",
      status: closedDaysAgo === null ? "in_progress" : "done", completedAt: closedDaysAgo === null ? null : new Date(Date.now() - closedDaysAgo * DAY_MS) });
    const cwd = await materializeIsolatedTaskDirectory({ companyId, issueId });
    await fs.writeFile(path.join(cwd, "report.md"), "final report\n");
    await fs.mkdir(path.join(cwd, "nested", "deeper"), { recursive: true });
    await fs.writeFile(path.join(cwd, "nested", "deeper", "data.json"), "{\"value\":1}\n");
    await fs.writeFile(path.join(cwd, "run.sh"), "#!/bin/sh\necho ok\n", { mode: 0o755 });
    await fs.symlink(outside, path.join(cwd, "outside-link"));
    await fs.writeFile(path.join(cwd, "package.json"), "{\"name\":\"fixture\"}\n");
    await fs.mkdir(path.join(cwd, "node_modules", "dep"), { recursive: true });
    await fs.writeFile(path.join(cwd, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issueId, mode: options.mode ?? "isolated_workspace",
      strategyType: "project_primary", name: "Fixture", status: options.status ?? "active", providerType: "local_fs", cwd,
      closedAt: options.status === "archived" ? new Date(Date.now() - closedDaysAgo! * DAY_MS) : null,
      metadata: { source: "task_session", createdByRuntime: false } });
    await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, issueId));
    await db.insert(issueWorkProducts).values({ companyId, issueId, executionWorkspaceId: workspaceId,
      type: "delivery_closeout", provider: "paperclip", title: "No-code task closeout", status: "active",
      metadata: { deliveryCloseout: { kind: "no_code", workspaceId, lifecycleGeneration: 0,
        reason: "Fixture task requires no published output." } } });
    const row = () => db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId)).then(rows => rows[0]!);
    const ledger = () => db.select().from(executionWorkspaceRestorePoints).where(eq(executionWorkspaceRestorePoints.executionWorkspaceId, workspaceId));
    const service = (overrides: Parameters<typeof executionWorkspaceService>[1] = {}) => executionWorkspaceService(db, {
      taskDirectoryRetention: settings, gitRestorePoints: restorePoints(), ...overrides });
    const expire = async (overrides: Partial<Parameters<typeof expireIsolatedTaskDirectory>[2]> = {}) => expireIsolatedTaskDirectory(db, await row(), {
      dryRun: false, now: new Date(), notBefore: new Date(Date.now() - DAY_MS), restorePoint: { storage: getStorageService(), keyDurable: true }, ...overrides });
    const reopen = () => executionWorkspaceService(db).reopenClosedIsolatedExecutionWorkspaceForIssue({ workspaceId,
      issue: { id: issueId, companyId, projectId: null }, actor: { actorType: "user", agentId: null },
      authorizationActor: { type: "board", source: "local_implicit", isInstanceAdmin: true } });
    return { companyId, issueId, workspaceId, agentId, cwd, row, ledger, service, expire, reopen };
  }

  async function expectRestored(cwd: string, options: { dependencies?: boolean; report?: string } = {}) {
    expect(await fs.readFile(path.join(cwd, "report.md"), "utf8")).toBe(options.report ?? "final report\n");
    expect(await fs.readFile(path.join(cwd, "nested", "deeper", "data.json"), "utf8")).toBe("{\"value\":1}\n");
    expect((await fs.stat(path.join(cwd, "run.sh"))).mode & 0o777).toBe(0o755);
    expect((await fs.lstat(path.join(cwd, "outside-link"))).isSymbolicLink()).toBe(true);
    expect(await fs.readlink(path.join(cwd, "outside-link"))).toBe(outside);
    expect(await exists(path.join(cwd, "package.json"))).toBe(true);
    expect(await exists(path.join(cwd, "node_modules", "dep", "index.js"))).toBe(options.dependencies ?? false);
  }

  it("archives and removes a closed issue's task directory after the delay and restores it on reopen", async () => {
    const service = executionWorkspaceService(db, { taskDirectoryRetention: settings, gitRestorePoints: restorePoints() });
    // Prime the independent folder walk before creating the bound workspace so
    // this test exercises the terminal workspace row path and its counters.
    await service.sweepTerminalWorkspaces();
    const f = await fixture();
    const result = await service.sweepTerminalWorkspaces();
    expect(result).toMatchObject({ archived: 1 });
    expect(await exists(f.cwd)).toBe(false);
    expect(await fs.readFile(path.join(outside, "keep.txt"), "utf8")).toBe("outside\n");
    const archived = await f.row();
    expect(archived).toMatchObject({ status: "archived", cleanupReason: "isolated task directory retention" });
    const state = readTaskDirectoryRetention(archived)!;
    expect(state).toMatchObject({ removed: true, restorePoint: { files: 4, excluded: 1 } });
    expect(await f.ledger()).toMatchObject([{ status: "active", objectKey: state.restorePoint.objectKey }]);

    expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
    await expectRestored(f.cwd);
    const reopened = await f.row();
    expect(reopened.status).toBe("active");
    expect(readTaskDirectoryRetention(reopened)).toBeNull();
    expect(await f.ledger()).toMatchObject([{ status: "superseded" }]);
  });

  it("retains a task folder with no typed closeout and explains the missing proof", async () => {
    const f = await fixture();
    await db.delete(issueWorkProducts).where(eq(issueWorkProducts.issueId, f.issueId));
    expect(await f.expire({ dryRun: true })).toMatchObject({ candidate: false, expired: false,
      skipReason: "delivery_closeout_missing" });
    const preview = await inspectIsolatedTaskDirectoryFolders(db, [{ companyId: f.companyId, issueId: f.issueId }],
      { dryRun: true, now: new Date(), orphanGraceMs: 7 * DAY_MS, terminalDelayMs: 3 * DAY_MS });
    expect(preview[0]).toMatchObject({ outcome: "skipped", reason: "delivery_closeout_missing",
      requiredEvidence: ["typed artifact or no-code delivery closeout for this workspace lifecycle"] });
    expect(preview[0]!.candidateBytes).toBeGreaterThan(0);
    expect(await exists(f.cwd)).toBe(true);
  });

  it("requires every artifact named by a closeout to remain published", async () => {
    const f = await fixture();
    await db.delete(issueWorkProducts).where(eq(issueWorkProducts.issueId, f.issueId));
    const artifactId = randomUUID();
    const attachmentId = randomUUID();
    const contentPath = `/api/attachments/${attachmentId}/content`;
    const assetId = randomUUID();
    await db.insert(assets).values({ id: assetId, companyId: f.companyId, provider: "local", objectKey: randomUUID(),
      contentType: "text/plain", byteSize: 6, sha256: "a".repeat(64) });
    await db.insert(issueAttachments).values({ id: attachmentId, companyId: f.companyId, issueId: f.issueId, assetId });
    await db.insert(issueWorkProducts).values({ id: artifactId, companyId: f.companyId, issueId: f.issueId,
      type: "artifact", provider: "paperclip", title: "Published report", status: "active",
      metadata: { attachmentId, contentType: "text/plain", byteSize: 6, contentPath, openPath: contentPath,
        downloadPath: `${contentPath}?download=1` } });
    await db.insert(issueWorkProducts).values({ companyId: f.companyId, issueId: f.issueId, executionWorkspaceId: f.workspaceId,
      type: "delivery_closeout", provider: "paperclip", title: "Artifact closeout", status: "active",
      metadata: { deliveryCloseout: { kind: "artifact", workspaceId: f.workspaceId, lifecycleGeneration: 0,
        artifactWorkProductIds: [artifactId] } } });
    expect(await f.expire({ dryRun: true })).toMatchObject({ candidate: true, skipReason: null });
    await db.update(issueWorkProducts).set({ status: "archived" }).where(eq(issueWorkProducts.id, artifactId));
    expect(await f.expire({ dryRun: true })).toMatchObject({ candidate: false, skipReason: "delivery_closeout_missing" });
  });

  it("restores a shared-workspace task directory through reopen", async () => {
    const f = await fixture({ mode: "shared_workspace" });
    expect(await f.expire()).toMatchObject({ expired: true, restorePoint: true });
    expect(await exists(f.cwd)).toBe(false);
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue.executionWorkspaceId).toBe(f.workspaceId);
    expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
    await expectRestored(f.cwd);
  });

  it("keeps the directory until the terminal delay and registers that deadline", async () => {
    const f = await fixture({ closedDaysAgo: 1 });
    const service = f.service();
    expect(await service.sweepTerminalWorkspaces()).toMatchObject({ archived: 0 });
    expect(await exists(f.cwd)).toBe(true);
    expect((await f.row()).status).toBe("active");
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const deadline = await service.nextTerminalWorkspaceSweepAt();
    expect(deadline).toBeGreaterThan(Date.now());
    expect(deadline).toBeLessThanOrEqual(issue.completedAt!.getTime() + 3 * DAY_MS);
    expect(await f.ledger()).toEqual([]);
  });

  it("keeps the directory while the issue is open", async () => {
    const f = await fixture({ closedDaysAgo: null });
    expect(await f.service().sweepTerminalWorkspaces()).toMatchObject({ archived: 0, skippedNonTerminalTree: 1 });
    expect(await exists(f.cwd)).toBe(true);
    expect(await f.ledger()).toEqual([]);
  });

  it("does nothing when retention is not configured", async () => {
    const f = await fixture();
    await executionWorkspaceService(db, { gitRestorePoints: restorePoints() }).sweepTerminalWorkspaces();
    expect(await exists(f.cwd)).toBe(true);
    expect((await f.row()).status).toBe("active");
  });

  type Consumer = (f: Awaited<ReturnType<typeof fixture>>) => Promise<unknown>;
  const consumers: Array<[string, Consumer, string]> = [
    ["a live run", f => db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running", contextSnapshot: { issueId: f.issueId } }),
      "live_or_unresolved_consumer"],
    ["a live runtime service", f => db.insert(workspaceRuntimeServices).values({ id: randomUUID(), companyId: f.companyId, scopeType: "execution_workspace",
      serviceName: "web", status: "running", lifecycle: "shared", provider: "local_process", executionWorkspaceId: f.workspaceId, cwd: f.cwd }),
      "live_or_unresolved_consumer"],
    ["a reopen fence", f => db.update(executionWorkspaces).set({ metadata: { source: "task_session", reopenPendingConsumption: true } })
      .where(eq(executionWorkspaces.id, f.workspaceId)), "live_or_unresolved_consumer"],
    ["an unsettled finalization", async f => {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, status: "succeeded",
        finishedAt: new Date(Date.now() - 4 * DAY_MS), nativeIssueId: f.issueId });
      await db.insert(nativeRunFinalizations).values({ runId, companyId: f.companyId, issueId: f.issueId, phase: "observed", leaseOwner: "native-finalizer:live" });
    }, "live_or_unresolved_consumer"],
    ["a live environment lease", f => db.insert(environmentLeases).values({ companyId: f.companyId, executionWorkspaceId: f.workspaceId, status: "active" }),
      "live_or_unresolved_consumer"],
    ["an unresolved recovery action", f => db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", status: "active", ownerType: "board", ownerAgentId: null, cause: "native_workspace_finalization_owner_unverified",
      fingerprint: randomUUID(), evidence: {}, nextAction: "Verify the owner." }), "live_or_unresolved_consumer"],
    ["an issue bound to another workspace", f => db.update(issues).set({ executionWorkspaceId: null }).where(eq(issues.id, f.issueId)), "issue_not_bound"],
    ["a sibling live workspace in the directory", f => db.insert(executionWorkspaces).values({ companyId: f.companyId, mode: "shared_workspace",
      strategyType: "project_primary", name: "Sibling", status: "active", providerType: "local_fs", cwd: path.join(f.cwd, "nested") }),
      "live_or_unresolved_consumer"],
  ];

  it.each(consumers)("keeps the directory while %s exists", async (_label, add, reason) => {
    const f = await fixture();
    await add(f);
    expect(await f.expire()).toMatchObject({ expired: false, skipReason: reason });
    expect(await exists(f.cwd)).toBe(true);
    expect((await f.row()).status).toBe("active");
    expect(await f.ledger()).toEqual([]);
  });

  it("removes the directory despite closed sibling rows at the same path", async () => {
    const f = await fixture();
    await db.insert(executionWorkspaces).values({ companyId: f.companyId, sourceIssueId: f.issueId, mode: "isolated_workspace",
      strategyType: "project_primary", name: "Old", status: "archived", closedAt: new Date(Date.now() - 10 * DAY_MS), providerType: "local_fs", cwd: f.cwd });
    expect(await f.expire()).toMatchObject({ expired: true });
  });

  it("refuses to remove without restore points or with a non-durable key", async () => {
    const f = await fixture();
    expect(await f.expire({ restorePoint: undefined })).toMatchObject({ expired: false, skipReason: "restore_points_disabled" });
    expect(await f.expire({ restorePoint: { storage: getStorageService(), keyDurable: false } }))
      .toMatchObject({ expired: false, skipReason: "restore_point_key_not_durable" });
    expect(await f.expire({ notBefore: new Date(Date.now() + DAY_MS) })).toMatchObject({ expired: false, skipReason: "not_due" });
    expect(await exists(f.cwd)).toBe(true);
    expect(await f.ledger()).toEqual([]);
  });

  it("keeps files it cannot save", async () => {
    const f = await fixture();
    expect(await f.expire({ restorePoint: { storage: getStorageService(), keyDurable: true, limits: { maxFiles: 2, maxFileBytes: 1024, maxTotalBytes: 4096 } } }))
      .toMatchObject({ expired: false, skipReason: "task_directory_too_many_files" });
    expect(await exists(f.cwd)).toBe(true);
    expect((await f.row()).status).toBe("active");
    expect(await f.ledger()).toEqual([]);
  });

  it("keeps a task directory containing an unpublished nested checkout", async () => {
    const f = await fixture();
    const repo = path.join(f.cwd, "repo");
    await fs.mkdir(repo);
    execFileSync("git", ["init", "-q", repo]);

    expect(await f.expire({ dryRun: true })).toMatchObject({ candidate: false, expired: false, skipReason: "nested_git_repository" });
    expect(await f.expire()).toMatchObject({ candidate: false, expired: false, skipReason: "nested_git_repository" });
    expect(await exists(repo)).toBe(true);
    expect((await f.row()).status).toBe("active");
    expect(await f.ledger()).toEqual([]);
  });

  /** A nested checkout whose commits are all on a local upstream standing in
   * for its GitHub origin, recorded by a code closeout when `delivered`. */
  async function publishedCheckout(f: Awaited<ReturnType<typeof fixture>>, relative: string, repository: string,
    options: { delivered?: boolean; origin?: string; detached?: boolean } = {}) {
    const remote = `https://github.com/${repository}.git`;
    const upstream = path.join(root, `upstream-${randomUUID()}.git`);
    const checkout = path.join(f.cwd, relative);
    await fs.mkdir(path.dirname(checkout), { recursive: true });
    execFileSync("git", ["init", "-q", "--bare", upstream], { env: GIT_ENV });
    execFileSync("git", ["clone", "-q", upstream, checkout], { env: GIT_ENV, stdio: "ignore" });
    git(checkout, "symbolic-ref", "HEAD", "refs/heads/main");
    await fs.writeFile(path.join(checkout, "README.md"), `${repository}\n`);
    git(checkout, "add", "README.md");
    git(checkout, "commit", "-q", "-m", "Deliver fixture");
    git(checkout, "push", "-q", "-u", "origin", "HEAD:main");
    git(checkout, "remote", "set-url", "origin", options.origin ?? remote);
    if (options.detached) git(checkout, "checkout", "-q", "--detach");
    gitFixture.upstreams.set(remote, upstream);
    if (options.origin) gitFixture.upstreams.set(options.origin, upstream);
    const head = git(checkout, "rev-parse", "HEAD");
    if (options.delivered) {
      await db.delete(issueWorkProducts).where(eq(issueWorkProducts.issueId, f.issueId));
      await db.insert(issueWorkProducts).values({ companyId: f.companyId, issueId: f.issueId, executionWorkspaceId: f.workspaceId,
        type: "delivery_closeout", provider: "paperclip", title: "Code task closeout", status: "active",
        metadata: { deliveryCloseout: { kind: "code", workspaceId: f.workspaceId, lifecycleGeneration: 0, headSha: head,
          pullRequestUrl: `https://github.com/${repository}/pull/7` } } });
    }
    return { checkout, head, remote, upstream };
  }

  /** A folder with outer files, the delivered checkout at repo/ (pushed with
   * an inline token in its origin) and a detached library checkout. */
  async function codeDeliveredFixture() {
    const f = await fixture();
    const delivered = await publishedCheckout(f, "repo", "example/delivered", { delivered: true,
      origin: "https://x-access-token:fixture-secret@github.com/example/delivered.git" });
    const library = await publishedCheckout(f, "vendor/lib", "example/library", { detached: true });
    return { ...f, delivered, library };
  }

  async function expectExactCheckouts(f: Awaited<ReturnType<typeof codeDeliveredFixture>>, options: { restored?: boolean } = {}) {
    if (options.restored === false) expect(await exists(path.join(f.cwd, "node_modules", "dep", "index.js"))).toBe(true);
    else await expectRestored(f.cwd);
    expect(git(f.delivered.checkout, "rev-parse", "HEAD")).toBe(f.delivered.head);
    expect(git(f.delivered.checkout, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
    expect(git(f.delivered.checkout, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/main");
    // A restored origin never carries the token the original clone embedded.
    expect(git(f.delivered.checkout, "remote", "get-url", "origin")).toBe(options.restored === false
      ? "https://x-access-token:fixture-secret@github.com/example/delivered.git" : DELIVERED_REMOTE);
    expect(git(f.delivered.checkout, "status", "--porcelain")).toBe("");
    expect(await fs.readFile(path.join(f.delivered.checkout, "README.md"), "utf8")).toBe("example/delivered\n");
    expect(git(f.library.checkout, "rev-parse", "HEAD")).toBe(f.library.head);
    expect(() => git(f.library.checkout, "symbolic-ref", "-q", "HEAD")).toThrow();
    expect(git(f.library.checkout, "status", "--porcelain")).toBe("");
  }

  describe("code-delivered task folders", () => {
    afterEach(() => { gitFixture.upstreams.clear(); gitFixture.calls = 0; gitFixture.beforeFetch = null; });

    it("previews a proven folder as a candidate while routine dry runs stay remote-free", async () => {
      const f = await codeDeliveredFixture();
      const preview = (proveRepositoryDelivery: boolean) => inspectIsolatedTaskDirectoryFolders(db,
        [{ companyId: f.companyId, issueId: f.issueId }], { dryRun: true, now: new Date(), orphanGraceMs: 7 * DAY_MS,
          terminalDelayMs: 3 * DAY_MS, restorePoint: { storage: getStorageService(), keyDurable: true }, proveRepositoryDelivery });
      const proven = await preview(true);
      expect(proven).toMatchObject([{ outcome: "dry_run", reason: null, requiredEvidence: [],
        verifiedEvidence: [
          expect.stringContaining(`repo/: github.com/example/delivered at ${f.delivered.head.slice(0, 12)} contains the delivered head`),
          expect.stringContaining(`vendor/lib/: github.com/example/library at ${f.library.head.slice(0, 12)}`),
          expect.stringContaining("outer task entries fit restore-point limits")] }]);
      expect(proven[0]!.candidateBytes).toBeGreaterThan(0);
      gitFixture.calls = 0;
      expect(await preview(false)).toMatchObject([{ outcome: "skipped", reason: "repository_publication_unverified", verifiedEvidence: [],
        requiredEvidence: ["verified repository publication and qualified outer artifacts"] }]);
      expect(gitFixture.calls).toBe(0);
      expect((await f.row()).status).toBe("active");
      expect(await f.ledger()).toEqual([]);
    });

    it("retires the folder after its publication proof and reopens the exact checkouts and outputs", async () => {
      const service = executionWorkspaceService(db, { taskDirectoryRetention: settings, gitRestorePoints: restorePoints() });
      // Prime the folder walk so the terminal workspace row path retires it.
      await service.sweepTerminalWorkspaces();
      const f = await codeDeliveredFixture();
      expect(await service.sweepTerminalWorkspaces()).toMatchObject({ archived: 1 });
      expect(await exists(f.cwd)).toBe(false);
      const archived = await f.row();
      const state = readTaskDirectoryRetention(archived)!;
      expect(state).toMatchObject({ removed: true, restorePoint: { schema: "paperclip.task-directory-restore-point.v2", files: 4, excluded: 1,
        repositories: [
          { path: "repo", repository: "example/delivered", remoteUrl: DELIVERED_REMOTE, head: f.delivered.head, branch: "main",
            upstream: "refs/heads/main" },
          { path: "vendor/lib", repository: "example/library", remoteUrl: "https://github.com/example/library.git", head: f.library.head,
            branch: null, upstream: null },
        ] } });
      expect(JSON.stringify(archived.metadata)).not.toContain("fixture-secret");
      expect(await f.ledger()).toMatchObject([{ status: "active", objectKey: state.restorePoint.objectKey }]);

      expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
      await expectExactCheckouts(f);
      expect(readTaskDirectoryRetention(await f.row())).toBeNull();
      expect(await f.ledger()).toMatchObject([{ status: "superseded" }]);
    }, 60_000);

    it("keeps dirty and unpublished checkout work", async () => {
      const dirty = await codeDeliveredFixture();
      await fs.writeFile(path.join(dirty.library.checkout, "scratch.txt"), "unpublished\n");
      expect(await dirty.expire()).toMatchObject({ candidate: false, expired: false, skipReason: "dirty_or_untracked_files",
        requiredEvidence: ["committed and published nested checkout changes"] });
      expect(await fs.readFile(path.join(dirty.library.checkout, "scratch.txt"), "utf8")).toBe("unpublished\n");
      expect((await dirty.row()).status).toBe("active");
      expect(await dirty.ledger()).toEqual([]);

      const unpushed = await codeDeliveredFixture();
      await fs.writeFile(path.join(unpushed.delivered.checkout, "later.txt"), "local only\n");
      git(unpushed.delivered.checkout, "add", "later.txt");
      git(unpushed.delivered.checkout, "commit", "-q", "-m", "Local follow-up");
      expect(await unpushed.expire()).toMatchObject({ expired: false, skipReason: "unpushed_managed_checkout" });
      expect(await exists(path.join(unpushed.delivered.checkout, "later.txt"))).toBe(true);
      expect(await unpushed.ledger()).toEqual([]);
    }, 60_000);

    it("finishes an interrupted retirement from local state alone and rolls back a later commit", async () => {
      const f = await codeDeliveredFixture();
      await expect(f.expire({ beforeDelete: async () => { throw new Error("simulated_crash"); } }))
        .resolves.toMatchObject({ expired: false, skipReason: "simulated_crash" });
      expect(readTaskDirectoryRetention(await f.row())).toMatchObject({ removed: false });
      gitFixture.calls = 0;
      expect(await f.service().sweepTerminalWorkspaces()).toMatchObject({ archived: 1 });
      expect(gitFixture.calls).toBe(0);
      expect(await exists(f.cwd)).toBe(false);
      expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
      await expectExactCheckouts(f);

      const late = await codeDeliveredFixture();
      await late.expire({ beforeDelete: async () => { throw new Error("simulated_crash"); } });
      await fs.writeFile(path.join(late.delivered.checkout, "late.txt"), "late work\n");
      git(late.delivered.checkout, "add", "late.txt");
      git(late.delivered.checkout, "commit", "-q", "-m", "Late unpublished work");
      expect(await late.expire({ dryRun: true })).toMatchObject({ expired: false, skipReason: "task_directory_changed" });
      expect(await late.expire()).toMatchObject({ expired: false, skipReason: "task_directory_changed" });
      expect(await exists(path.join(late.delivered.checkout, "late.txt"))).toBe(true);
      const row = await late.row();
      expect(row.status).toBe("active");
      expect(readTaskDirectoryRetention(row)).toBeNull();
      expect(await late.ledger()).toMatchObject([{ status: "superseded" }]);
    }, 60_000);

    /** Leave the state a crash right after the rename into trash leaves. */
    async function crashAfterRename(f: Awaited<ReturnType<typeof codeDeliveredFixture>>) {
      await f.expire({ beforeDelete: async () => { throw new Error("simulated_crash"); } });
      const state = readTaskDirectoryRetention(await f.row())!;
      await fs.rename(f.cwd, state.trash);
      return state;
    }

    it("checks a folder left renamed by a crash and keeps a commit made in it afterwards", async () => {
      const f = await codeDeliveredFixture();
      const state = await crashAfterRename(f);
      gitFixture.calls = 0;
      expect(await f.service().sweepTerminalWorkspaces()).toMatchObject({ archived: 1 });
      expect(gitFixture.calls).toBe(0);
      expect(await exists(state.trash)).toBe(false);
      expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
      await expectExactCheckouts(f);

      const late = await codeDeliveredFixture();
      const lateState = await crashAfterRename(late);
      // A process still inside the renamed folder keeps working.
      const moved = path.join(lateState.trash, "repo");
      await fs.writeFile(path.join(moved, "late.txt"), "late work\n");
      git(moved, "add", "late.txt");
      git(moved, "commit", "-q", "-m", "Late unpublished work");
      gitFixture.calls = 0;
      expect(await late.expire({ dryRun: true })).toMatchObject({ expired: false, skipReason: "task_directory_changed" });
      expect(await exists(lateState.trash)).toBe(true);
      expect(await late.expire()).toMatchObject({ expired: false, skipReason: "task_directory_changed" });
      expect(gitFixture.calls).toBe(0);
      expect(await exists(lateState.trash)).toBe(false);
      expect(git(late.delivered.checkout, "log", "-1", "--format=%s")).toBe("Late unpublished work");
      const row = await late.row();
      expect(row.status).toBe("active");
      expect(readTaskDirectoryRetention(row)).toBeNull();
      expect(await late.ledger()).toMatchObject([{ status: "superseded" }]);
    }, 60_000);

    it("reopens a folder left renamed by a crash as it is, with later work", async () => {
      const f = await codeDeliveredFixture();
      const state = await crashAfterRename(f);
      const moved = path.join(state.trash, "repo");
      await fs.writeFile(path.join(moved, "late.txt"), "late work\n");
      git(moved, "add", "late.txt");
      git(moved, "commit", "-q", "-m", "Late unpublished work");
      gitFixture.calls = 0;
      expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
      expect(gitFixture.calls).toBe(0);
      expect(await exists(state.trash)).toBe(false);
      expect(git(f.delivered.checkout, "log", "-1", "--format=%s")).toBe("Late unpublished work");
      expect(await exists(path.join(f.cwd, "node_modules", "dep", "index.js"))).toBe(true);
      expect(readTaskDirectoryRetention(await f.row())).toBeNull();
    }, 60_000);

    it("finishes a partly completed removal on restart and reopens from the restore point", async () => {
      const f = await codeDeliveredFixture();
      await expect(f.expire({ beforeRemove: async trash => {
        await fs.rm(path.join(trash, "repo"), { recursive: true, force: true });
        throw new Error("simulated_crash");
      } })).resolves.toMatchObject({ expired: false, skipReason: "simulated_crash" });
      const state = readTaskDirectoryRetention(await f.row())!;
      expect(state).toMatchObject({ removed: false, removalCheckedAt: expect.any(String) });
      expect(await exists(state.trash)).toBe(true);
      gitFixture.calls = 0;
      expect(await f.expire({ dryRun: true })).toMatchObject({ candidate: true, skipReason: null });
      expect(await f.service().sweepTerminalWorkspaces()).toMatchObject({ archived: 1 });
      expect(gitFixture.calls).toBe(0);
      expect(await exists(state.trash)).toBe(false);
      expect(readTaskDirectoryRetention(await f.row())).toMatchObject({ removed: true });
      expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
      await expectExactCheckouts(f);
    }, 60_000);

    it("finishes a partial removal that deleted the package.json beside its dependencies", async () => {
      const f = await codeDeliveredFixture();
      await fs.mkdir(path.join(f.cwd, "node_modules", "dep", "lib"), { recursive: true });
      const state = await stopRemoval(f, async trash => { await fs.rm(path.join(trash, "package.json")); });
      expect(await exists(path.join(state.trash, "node_modules", "dep", "lib"))).toBe(true);
      gitFixture.calls = 0;
      expect(await f.expire({ dryRun: true })).toMatchObject({ candidate: true, skipReason: null });
      expect(await f.service().sweepTerminalWorkspaces()).toMatchObject({ archived: 1 });
      expect(gitFixture.calls).toBe(0);
      expect(await exists(state.trash)).toBe(false);
      expect(readTaskDirectoryRetention(await f.row())).toMatchObject({ removed: true });
    }, 60_000);

    /** Commit new unpublished work in the delivered checkout inside `folder`. */
    async function commitLateWork(folder: string) {
      const moved = path.join(folder, "repo");
      await fs.writeFile(path.join(moved, "late.txt"), "late work\n");
      git(moved, "add", "late.txt");
      git(moved, "commit", "-q", "-m", "Late unpublished work");
      return git(moved, "rev-parse", "HEAD");
    }

    /** Stop a removal once its marker is saved, after `partly` ran on the trash. */
    async function stopRemoval(f: Awaited<ReturnType<typeof codeDeliveredFixture>>, partly: (trash: string) => Promise<void>) {
      await expect(f.expire({ beforeRemove: async trash => {
        await partly(trash);
        throw new Error("simulated_crash");
      } })).resolves.toMatchObject({ expired: false, skipReason: "simulated_crash" });
      const state = readTaskDirectoryRetention(await f.row())!;
      expect(state).toMatchObject({ removed: false, removalCheckedAt: expect.any(String) });
      return state;
    }

    /** A restart must keep work made in the trash after its removal began. */
    async function expectRemainderKept(f: Awaited<ReturnType<typeof codeDeliveredFixture>>) {
      gitFixture.calls = 0;
      expect(await f.expire({ dryRun: true })).toMatchObject({ expired: false, skipReason: "task_directory_later_work" });
      expect(await f.expire()).toMatchObject({ expired: false, skipReason: "task_directory_later_work" });
      expect(await f.service().sweepTerminalWorkspaces()).toMatchObject({ archived: 0 });
      // The trash sweep leaves a pending intent's trash to that intent's check.
      await sweepIsolatedTaskDirectories(db, { dryRun: false, now: new Date(Date.now() + 2 * DAY_MS), orphanGraceMs: 7 * DAY_MS,
        terminalDelayMs: 3 * DAY_MS, restorePoint: { storage: getStorageService(), keyDurable: true } });
      expect(gitFixture.calls).toBe(0);
      expect(readTaskDirectoryRetention(await f.row())).toMatchObject({ removed: false });
    }

    /** Reopen keeps the partly removed folder itself, filled in from the
     * restore point, with its later work and nothing left in staging. */
    async function expectReopenedWithRemainder(f: Awaited<ReturnType<typeof codeDeliveredFixture>>, trash: string,
      options: { report?: string } = {}) {
      expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
      expect(await exists(trash)).toBe(false);
      expect((await fs.readdir(path.dirname(f.cwd))).filter(name => name.startsWith(".restoring-"))).toEqual([]);
      await expectRestored(f.cwd, { dependencies: true, report: options.report });
      expect(git(f.library.checkout, "rev-parse", "HEAD")).toBe(f.library.head);
      expect(git(f.library.checkout, "status", "--porcelain")).toBe("");
      expect(readTaskDirectoryRetention(await f.row())).toBeNull();
    }

    async function expectLaterWorkKept(f: Awaited<ReturnType<typeof codeDeliveredFixture>>, trash: string, late: string) {
      await expectRemainderKept(f);
      expect(git(path.join(trash, "repo"), "rev-parse", "HEAD")).toBe(late);
      await expectReopenedWithRemainder(f, trash);
      expect(git(f.delivered.checkout, "rev-parse", "HEAD")).toBe(late);
      expect(git(f.delivered.checkout, "rev-parse", "HEAD^")).toBe(f.delivered.head);
      expect(git(f.delivered.checkout, "status", "--porcelain")).toBe("");
      expect(await fs.readFile(path.join(f.delivered.checkout, "late.txt"), "utf8")).toBe("late work\n");
    }

    it("keeps a commit made in the trash after the removal marker but before any deletion", async () => {
      const f = await codeDeliveredFixture();
      const state = await stopRemoval(f, async () => undefined);
      await expectLaterWorkKept(f, state.trash, await commitLateWork(state.trash));
    }, 90_000);

    it("keeps a commit made in a checkout a partial removal left behind", async () => {
      const f = await codeDeliveredFixture();
      const state = await stopRemoval(f, async trash => {
        await fs.rm(path.join(trash, "report.md"));
        await fs.rm(path.join(trash, "vendor"), { recursive: true, force: true });
      });
      expect(await exists(path.join(state.trash, "report.md"))).toBe(false);
      await expectLaterWorkKept(f, state.trash, await commitLateWork(state.trash));
    }, 90_000);

    it("keeps older directories moved into a partly removed folder", async () => {
      const f = await codeDeliveredFixture();
      // Made before the removal check, so every file keeps an older change time.
      const older = async (name: string) => {
        const folder = path.join(root, `older-${randomUUID()}`);
        await fs.mkdir(path.join(folder, "inner"), { recursive: true });
        await fs.writeFile(path.join(folder, "inner", `${name}.txt`), `${name} work\n`);
        return folder;
      };
      const outer = await older("outer"), inCheckout = await older("checkout");
      await new Promise(resolve => setTimeout(resolve, 250));
      const state = await stopRemoval(f, async trash => {
        await fs.rm(path.join(trash, "report.md"));
        await fs.rm(path.join(trash, "vendor"), { recursive: true, force: true });
      });
      // Only the moved directories themselves change: nothing inside them is
      // newer than the check, so file times alone cannot reveal them.
      const checkedAt = Date.parse(state.removalCheckedAt!);
      for (const folder of [outer, inCheckout]) {
        for (const entry of [path.join(folder, "inner"), ...(await fs.readdir(path.join(folder, "inner"))).map(name => path.join(folder, "inner", name))]) {
          const stat = await fs.lstat(entry);
          expect(Math.max(stat.ctimeMs, stat.mtimeMs)).toBeLessThan(checkedAt);
        }
      }
      await fs.rename(outer, path.join(state.trash, "nested", "moved"));
      await fs.rename(inCheckout, path.join(state.trash, "repo", "moved"));
      expect(await fs.readFile(path.join(state.trash, "nested", "moved", "inner", "outer.txt"), "utf8")).toBe("outer work\n");
      await expectRemainderKept(f);
      expect(await fs.readFile(path.join(state.trash, "repo", "moved", "inner", "checkout.txt"), "utf8")).toBe("checkout work\n");

      await expectReopenedWithRemainder(f, state.trash);
      expect(await fs.readFile(path.join(f.cwd, "nested", "moved", "inner", "outer.txt"), "utf8")).toBe("outer work\n");
      expect(await fs.readFile(path.join(f.delivered.checkout, "moved", "inner", "checkout.txt"), "utf8")).toBe("checkout work\n");
      expect(git(f.delivered.checkout, "rev-parse", "HEAD")).toBe(f.delivered.head);
    }, 90_000);

    it("keeps an older directory moved in where removed dependencies were", async () => {
      const f = await codeDeliveredFixture();
      await fs.mkdir(path.join(f.cwd, "node_modules", "dep"), { recursive: true });
      const older = path.join(root, `older-${randomUUID()}`);
      await fs.mkdir(older);
      await fs.writeFile(path.join(older, "notes.txt"), "older work\n");
      await new Promise(resolve => setTimeout(resolve, 250));
      const state = await stopRemoval(f, async trash => {
        await fs.rm(path.join(trash, "package.json"));
        await fs.rm(path.join(trash, "node_modules"), { recursive: true });
      });
      // The recorded dependencies are gone, so the moved directory at their
      // path is not theirs and is later work.
      await fs.rename(older, path.join(state.trash, "node_modules"));
      await expectRemainderKept(f);
      expect(await fs.readFile(path.join(state.trash, "node_modules", "notes.txt"), "utf8")).toBe("older work\n");
    }, 90_000);

    it("keeps work written in a partly removed folder while its reopen fetches", async () => {
      const f = await codeDeliveredFixture();
      const state = await stopRemoval(f, async trash => {
        await fs.rm(path.join(trash, "report.md"));
        await fs.rm(path.join(trash, "vendor"), { recursive: true, force: true });
      });
      let writes = 0;
      gitFixture.beforeFetch = async () => {
        writes += 1;
        await fs.writeFile(path.join(state.trash, `during-fetch-${writes}.txt`), "written during the fetch\n");
        await fs.writeFile(path.join(state.trash, "repo", `during-fetch-${writes}.txt`), "written in the checkout\n");
        // Rewrites a saved file the partial removal deleted: the rebuilt copy
        // must not replace it.
        await fs.writeFile(path.join(state.trash, "report.md"), "rewritten during the fetch\n");
      };
      await expectReopenedWithRemainder(f, state.trash, { report: "rewritten during the fetch\n" });
      expect(writes).toBeGreaterThan(0);
      for (let index = 1; index <= writes; index += 1) {
        expect(await fs.readFile(path.join(f.cwd, `during-fetch-${index}.txt`), "utf8")).toBe("written during the fetch\n");
        expect(await fs.readFile(path.join(f.delivered.checkout, `during-fetch-${index}.txt`), "utf8")).toBe("written in the checkout\n");
      }
      expect(git(f.delivered.checkout, "rev-parse", "HEAD")).toBe(f.delivered.head);
    }, 90_000);

    /** A private directory outside the task folder, and a check that reopen
     * neither wrote into it nor changed its mode. */
    async function outsideTarget() {
      const outside = path.join(root, `outside-${randomUUID()}`);
      await fs.mkdir(outside);
      await fs.writeFile(path.join(outside, "private.txt"), "private\n");
      await fs.chmod(outside, 0o700);
      return {
        path: outside,
        async expectUntouched() {
          expect(await fs.readdir(outside)).toEqual(["private.txt"]);
          expect((await fs.stat(outside)).mode & 0o777).toBe(0o700);
        },
      };
    }

    /** Replace the live checkout with a symlink to `outside` once reopen's
     * reconcile has created or found `name` in `parent`. */
    function swapCheckoutAt(trash: string, parent: string, name: string, outside: string) {
      const held = path.join(root, `held-${randomUUID()}`);
      const mkdir = fs.mkdir.bind(fs);
      let swapped = false;
      const spy = vi.spyOn(fs, "mkdir").mockImplementation((async (target: string, options?: unknown) => {
        try {
          return await mkdir(target, options as Parameters<typeof fs.mkdir>[1]);
        } finally {
          if (!swapped && path.basename(String(target)) === name
            && await fs.realpath(path.dirname(String(target))).catch(() => null) === parent) {
            swapped = true;
            await fs.rename(path.join(trash, "repo"), held);
            await fs.symlink(outside, path.join(trash, "repo"));
          }
        }
      }) as typeof fs.mkdir);
      return { held, swapped: () => swapped, restore: () => spy.mockRestore() };
    }

    it.each([
      ["after its check, before reconcile descends into it", "", "repo"],
      ["while reconcile is filling it", "repo", ".git"],
    ])("never writes through a checkout replaced by a symlink %s", async (_label, parent, name) => {
      const f = await codeDeliveredFixture();
      const state = await stopRemoval(f, async trash => {
        await fs.rm(path.join(trash, "report.md"));
        await fs.rm(path.join(trash, "vendor"), { recursive: true, force: true });
      });
      const outside = await outsideTarget();
      const swap = swapCheckoutAt(state.trash, path.join(state.trash, parent), name, outside.path);
      try {
        // The replacement is live work and is kept as it stands; the rest of
        // the folder is still filled in.
        expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
      } finally {
        swap.restore();
      }
      expect(swap.swapped()).toBe(true);
      await outside.expectUntouched();
      expect((await fs.lstat(f.delivered.checkout)).isSymbolicLink()).toBe(true);
      expect(await fs.readlink(f.delivered.checkout)).toBe(outside.path);
      // The checkout moved away is whole, and anything filled in after the
      // swap went into it rather than outside.
      expect(git(swap.held, "rev-parse", "HEAD")).toBe(f.delivered.head);
      expect(git(swap.held, "status", "--porcelain")).toBe("");
      expect(await fs.readFile(path.join(f.cwd, "report.md"), "utf8")).toBe("final report\n");
      expect(git(f.library.checkout, "rev-parse", "HEAD")).toBe(f.library.head);
      expect((await fs.readdir(path.dirname(f.cwd))).filter(entry => entry.startsWith(".restoring-"))).toEqual([]);
    }, 90_000);

    it("fails closed when the partly removed folder is replaced before it moves into place", async () => {
      const f = await codeDeliveredFixture();
      const state = await stopRemoval(f, async trash => { await fs.rm(path.join(trash, "report.md")); });
      const outside = await outsideTarget();
      const held = path.join(root, `held-${randomUUID()}`);
      const rename = fs.rename.bind(fs);
      let swapped = false;
      const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (!swapped && String(from) === state.trash && String(to) === f.cwd) {
          swapped = true;
          await rename(state.trash, held);
          await fs.symlink(outside.path, state.trash);
        }
        return rename(from, to);
      });
      try {
        expect(await f.reopen()).toMatchObject({ ok: false, code: "rebuild_failed" });
      } finally {
        spy.mockRestore();
      }
      expect(swapped).toBe(true);
      await outside.expectUntouched();
      // Nothing outside is put in place of the folder, and the filled folder
      // that was moved away keeps its checkout and the refilled report.
      expect(await exists(f.cwd)).toBe(false);
      expect((await fs.lstat(state.trash)).isSymbolicLink()).toBe(true);
      expect(git(path.join(held, "repo"), "rev-parse", "HEAD")).toBe(f.delivered.head);
      expect(await fs.readFile(path.join(held, "report.md"), "utf8")).toBe("final report\n");
      expect(readTaskDirectoryRetention(await f.row())).toMatchObject({ removed: false });
    }, 90_000);

    it("keeps a partly removed folder whose removal record is missing", async () => {
      const f = await codeDeliveredFixture();
      const state = await stopRemoval(f, async trash => { await fs.rm(path.join(trash, "report.md")); });
      expect(state.removalRecord).toMatch(/^[0-9a-f]{64}$/);
      const records = path.join(root, "home", "instances", "default", "isolated-workspaces", ".removal-records");
      expect(await fs.readdir(records)).toEqual([`${f.workspaceId}-${state.restorePoint.id}.json`]);
      await fs.rm(records, { recursive: true });
      await expectRemainderKept(f);
      await expectReopenedWithRemainder(f, state.trash);
      await expectExactCheckouts(f, { restored: false });
    }, 90_000);

    it("keeps the folder closed and whole when a reopen cannot fetch, then restores on retry", async () => {
      const f = await codeDeliveredFixture();
      expect(await f.expire()).toMatchObject({ expired: true });
      const upstream = gitFixture.upstreams.get(DELIVERED_REMOTE)!;
      gitFixture.upstreams.set(DELIVERED_REMOTE, path.join(root, "missing-upstream.git"));
      expect(await f.reopen()).toMatchObject({ ok: false, code: "rebuild_failed" });
      expect(await exists(f.cwd)).toBe(false);
      expect((await fs.readdir(path.dirname(f.cwd))).filter(name => name.startsWith(".restoring-"))).toEqual([]);
      expect((await f.row()).status).toBe("archived");
      expect(readTaskDirectoryRetention(await f.row())).toMatchObject({ removed: true });

      gitFixture.upstreams.set(DELIVERED_REMOTE, upstream);
      expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
      await expectExactCheckouts(f);
    }, 60_000);

    it("accepts a folder already restored before a crash and refuses one that diverged", async () => {
      const f = await codeDeliveredFixture();
      expect(await f.expire()).toMatchObject({ expired: true });
      const archived = await f.row();
      const { restoreIsolatedTaskDirectory } = await import("../services/isolated-task-directory-retention.js");
      const { createIssueGitRemoteAuthProvider } = await import("../services/git-credentials.js");
      const resolveGitAuth = createIssueGitRemoteAuthProvider(db, f.companyId, f.issueId);
      expect(await restoreIsolatedTaskDirectory({ storage: getStorageService(), workspace: archived, resolveGitAuth }))
        .toMatchObject({ restored: true, repositories: 2 });
      // The process stopped before the reopen recorded it; the next reopen
      // recognizes the exact folder instead of failing or overwriting it.
      expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
      await expectExactCheckouts(f);

      const diverged = await codeDeliveredFixture();
      expect(await diverged.expire()).toMatchObject({ expired: true });
      await restoreIsolatedTaskDirectory({ storage: getStorageService(), workspace: await diverged.row(), resolveGitAuth });
      await fs.writeFile(path.join(diverged.delivered.checkout, "README.md"), "edited after restore\n");
      expect(await diverged.reopen()).toMatchObject({ ok: false, code: "rebuild_failed" });
      expect(await fs.readFile(path.join(diverged.delivered.checkout, "README.md"), "utf8")).toBe("edited after restore\n");
    }, 60_000);

    it("keeps the folder when its restore point cannot be stored", async () => {
      const f = await codeDeliveredFixture();
      const storage = getStorageService();
      const full = { ...storage, putFile: async () => {
        throw Object.assign(new Error("Disk quota exceeded"), { code: "EDQUOT" });
      } } as typeof storage;
      const result = await f.expire({ restorePoint: { storage: full, keyDurable: true } });
      expect(result).toMatchObject({ expired: false, restorePoint: false });
      expect(result.skipReason).not.toBeNull();
      await expectExactCheckouts(f, { restored: false });
      expect((await f.row()).status).toBe("active");
      expect(readTaskDirectoryRetention(await f.row())).toBeNull();
      expect((await f.ledger()).filter(entry => entry.status === "active")).toEqual([]);
    });

    it("retires one physical folder through duplicate aliases and keeps one shared with a live workspace", async () => {
      const f = await codeDeliveredFixture();
      await db.insert(executionWorkspaces).values({ companyId: f.companyId, sourceIssueId: f.issueId, mode: "isolated_workspace",
        strategyType: "project_primary", name: "Old alias", status: "archived", closedAt: new Date(Date.now() - 10 * DAY_MS),
        providerType: "local_fs", cwd: f.cwd });
      const sweep = () => inspectIsolatedTaskDirectoryFolders(db, Array.from({ length: 3 }, () => ({ companyId: f.companyId, issueId: f.issueId })),
        { ...settings, now: new Date(), restorePoint: { storage: getStorageService(), keyDurable: true } });
      const results = await sweep();
      expect(results).toMatchObject([{ outcome: "preserved_and_removed", executionWorkspaceId: f.workspaceId }]);
      expect(await exists(f.cwd)).toBe(false);
      expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
      await expectExactCheckouts(f);

      const shared = await codeDeliveredFixture();
      await db.insert(executionWorkspaces).values({ companyId: shared.companyId, mode: "shared_workspace", strategyType: "project_primary",
        name: "Shared root", status: "active", providerType: "local_fs", cwd: shared.delivered.checkout });
      expect(await inspectIsolatedTaskDirectoryFolders(db, [{ companyId: shared.companyId, issueId: shared.issueId }],
        { ...settings, now: new Date(), restorePoint: { storage: getStorageService(), keyDurable: true } }))
        .toMatchObject([{ outcome: "skipped", reason: "live_workspace" }]);
      await expectExactCheckouts(shared, { restored: false });
      expect(await shared.ledger()).toEqual([]);
    }, 60_000);
  });

  it("reports candidates in dry run without changing anything", async () => {
    const f = await fixture();
    const result = await f.service({ taskDirectoryRetention: { ...settings, dryRun: true }, gitRestorePoints: undefined }).sweepTerminalWorkspaces();
    expect(result).toMatchObject({ eligible: 1, archived: 0 });
    expect(await exists(f.cwd)).toBe(true);
    expect((await f.row()).status).toBe("active");
    expect(await f.ledger()).toEqual([]);
  });

  it("rolls back when the directory changes after it was saved", async () => {
    const f = await fixture();
    const result = await f.expire({ beforeDelete: async () => { await fs.writeFile(path.join(f.cwd, "late.txt"), "late work\n"); } });
    expect(result, JSON.stringify(result.failure)).toMatchObject({ expired: false, skipReason: "task_directory_changed" });
    expect(await fs.readFile(path.join(f.cwd, "late.txt"), "utf8")).toBe("late work\n");
    const row = await f.row();
    expect(row.status).toBe("active");
    expect(readTaskDirectoryRetention(row)).toBeNull();
    expect(await f.ledger()).toMatchObject([{ status: "superseded" }]);
  });

  it("finishes an interrupted removal on the next sweep", async () => {
    const f = await fixture();
    await expect(f.expire({ beforeDelete: async () => { throw new Error("simulated_crash"); } }))
      .resolves.toMatchObject({ expired: false, skipReason: "simulated_crash" });
    expect(await exists(f.cwd)).toBe(true);
    expect(readTaskDirectoryRetention(await f.row())).toMatchObject({ removed: false });
    expect(await f.service().sweepTerminalWorkspaces()).toMatchObject({ archived: 1 });
    expect(await exists(f.cwd)).toBe(false);
    expect(readTaskDirectoryRetention(await f.row())).toMatchObject({ removed: true });
  });

  it("does not preview stale saved contents after an interrupted removal", async () => {
    const f = await fixture();
    await f.expire({ beforeDelete: async () => { throw new Error("simulated_crash"); } });
    const saved = readTaskDirectoryRetention(await f.row());
    expect(saved).toMatchObject({ removed: false });

    await fs.writeFile(path.join(f.cwd, "late.txt"), "unpublished work\n");
    expect(await f.expire({ dryRun: true })).toMatchObject({ candidate: false, expired: false,
      skipReason: "task_directory_changed" });
    expect(await exists(f.cwd)).toBe(true);
    expect(readTaskDirectoryRetention(await f.row())).toEqual(saved);
  });

  it("never follows a task directory that is a symbolic link", async () => {
    const f = await fixture();
    const moved = path.join(root, `moved-${f.issueId}`);
    await fs.rename(f.cwd, moved);
    await fs.symlink(moved, f.cwd);
    expect(await f.expire()).toMatchObject({ expired: false, skipReason: "unsafe_task_directory" });
    expect(await fs.readFile(path.join(moved, "report.md"), "utf8")).toBe("final report\n");
    expect(await f.ledger()).toEqual([]);
    await fs.rm(f.cwd);
    await fs.rm(moved, { recursive: true });
  });

  it("reopens an empty directory with a warning when the saved files expired", async () => {
    const f = await fixture();
    expect(await f.expire()).toMatchObject({ expired: true });
    const [ledger] = await f.ledger();
    await markGitRestorePointExpired(db, ledger!);
    expect(readTaskDirectoryRetention(await f.row())?.restorePoint.expiredAt).toEqual(expect.any(String));
    expect(await f.reopen()).toMatchObject({ ok: true, reopened: true, warning: TASK_DIRECTORY_RESTORE_POINT_EXPIRED_WARNING });
    expect(await fs.readdir(f.cwd)).toEqual([]);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
    expect(comments.map(comment => comment.body)).toContain(TASK_DIRECTORY_RESTORE_POINT_EXPIRED_WARNING);
  });

  it("refuses to restore over a directory that diverged after removal", async () => {
    const f = await fixture();
    expect(await f.expire()).toMatchObject({ expired: true });
    await fs.mkdir(f.cwd);
    await fs.writeFile(path.join(f.cwd, "other.txt"), "unrelated\n");
    expect(await f.reopen()).toMatchObject({ ok: false, code: "rebuild_failed" });
    expect(await fs.readFile(path.join(f.cwd, "other.txt"), "utf8")).toBe("unrelated\n");
    expect((await f.row()).status).toBe("archived");
  });

  it("saves and restores file names that contain a backslash", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.cwd, "report\\final.txt"), "backslash name\n");
    expect(await f.expire()).toMatchObject({ expired: true });
    expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
    expect(await fs.readFile(path.join(f.cwd, "report\\final.txt"), "utf8")).toBe("backslash name\n");
  });

  it("restores a deep path that fills the platform path length", async () => {
    const f = await fixture();
    let deep = f.cwd;
    while (deep.length < 1000) deep = path.join(deep, "d".repeat(Math.min(60, 1000 - deep.length)));
    await fs.mkdir(deep, { recursive: true });
    const file = path.join(deep, "z".repeat(Math.max(1, 1015 - deep.length)));
    await fs.writeFile(file, "deep\n");
    expect(await f.expire()).toMatchObject({ expired: true });
    expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
    expect(await fs.readFile(file, "utf8")).toBe("deep\n");
  });

  it("keeps an expiry recorded while the directory was being removed, and records activity", async () => {
    const f = await fixture();
    const result = await f.expire({ beforeDelete: async () => {
      const [ledger] = await f.ledger();
      await markGitRestorePointExpired(db, ledger!);
    } });
    expect(result).toMatchObject({ expired: true });
    expect(readTaskDirectoryRetention(await f.row())).toMatchObject({ removed: true, restorePoint: { expiredAt: expect.any(String) } });
    const actions = await db.select({ action: activityLog.action }).from(activityLog).where(eq(activityLog.entityId, f.workspaceId));
    expect(actions.map(row => row.action).sort()).toEqual(["execution_workspace.task_directory_archived", "execution_workspace.task_directory_removed"]);
  });

  it("keeps a new restore point for the full retention even when the task closed long ago", async () => {
    const f = await fixture({ closedDaysAgo: 120 });
    expect(await f.expire()).toMatchObject({ expired: true });
    const retention = gitRestorePointRetentionService(db, { storage: getStorageService(), retentionDays: 90 });
    await retention.tick();
    expect(await f.ledger()).toMatchObject([{ status: "active" }]);
    expect(readTaskDirectoryRetention(await f.row())?.restorePoint.expiredAt).toBeUndefined();
    expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
    await expectRestored(f.cwd);
  });

  it("does not let skipped rows starve later rows of the per-sweep budget", async () => {
    const service = executionWorkspaceService(db, { taskDirectoryRetention: { ...settings, perSweep: 1 },
      gitRestorePoints: restorePoints() });
    await service.sweepTerminalWorkspaces();
    const blocked = await fixture();
    execFileSync("mkfifo", [path.join(blocked.cwd, "pipe")]);
    const ready = await fixture();
    await db.update(executionWorkspaces).set({ updatedAt: new Date(Date.now() - 60_000) }).where(eq(executionWorkspaces.id, blocked.workspaceId));
    expect(await service.sweepTerminalWorkspaces()).toMatchObject({ archived: 0 });
    expect(await exists(ready.cwd)).toBe(true);
    expect(await service.sweepTerminalWorkspaces()).toMatchObject({ archived: 1 });
    expect(await exists(ready.cwd)).toBe(false);
    expect(await exists(blocked.cwd)).toBe(true);
  });

  describe("folder sweep", () => {
    const sweep = (overrides: Partial<Parameters<typeof sweepIsolatedTaskDirectories>[1]> = {}) => sweepIsolatedTaskDirectories(db, {
      dryRun: false, now: new Date(), orphanGraceMs: 7 * DAY_MS, terminalDelayMs: 3 * DAY_MS,
      restorePoint: { storage: getStorageService(), keyDurable: true }, ...overrides });

    it("reports the restore-point prerequisite for a bound directory in dry run", async () => {
      const f = await fixture({ status: "archived" });
      const results = await inspectIsolatedTaskDirectoryFolders(db, [{ companyId: f.companyId, issueId: f.issueId }], {
        dryRun: true, now: new Date(), orphanGraceMs: 7 * DAY_MS, terminalDelayMs: 3 * DAY_MS,
      });
      expect(results).toMatchObject([{ issueId: f.issueId, outcome: "dry_run",
        requiredEvidence: ["configured durable restore-point storage"] }]);
      expect(await exists(f.cwd)).toBe(true);
    });

    async function orphan(options: { modifiedDaysAgo?: number; withContents?: boolean } = {}) {
      const companyId = randomUUID(), issueId = randomUUID();
      const cwd = await materializeIsolatedTaskDirectory({ companyId, issueId });
      if (options.withContents) {
        await fs.writeFile(path.join(cwd, "left.txt"), "left behind\n");
        await fs.symlink(outside, path.join(cwd, "outside-link"));
      }
      await age(cwd, new Date(Date.now() - (options.modifiedDaysAgo ?? 10) * DAY_MS));
      return { companyId, issueId, cwd };
    }

    it("removes an empty orphan whose issue is gone after the grace period", async () => {
      const o = await orphan();
      const batch = await sweep();
      expect(batch.results).toMatchObject([{ issueId: o.issueId, outcome: "removed", reason: null }]);
      expect(batch.results[0]!.reclaimedBytes).toBeGreaterThan(0);
      expect(await exists(o.cwd)).toBe(false);
      expect(await fs.readFile(path.join(outside, "keep.txt"), "utf8")).toBe("outside\n");
    });

    it("keeps a recently modified orphan and schedules its deadline", async () => {
      const o = await orphan({ modifiedDaysAgo: 2 });
      const batch = await sweep();
      expect(batch.results).toMatchObject([{ issueId: o.issueId, outcome: "skipped", reason: "recently_modified" }]);
      expect(batch.results[0]!.retryAt).toBeGreaterThan(Date.now() + 4 * DAY_MS);
      expect(await exists(o.cwd)).toBe(true);
    });

    it("keeps an orphan in dry run", async () => {
      const o = await orphan();
      const batch = await sweep({ dryRun: true });
      expect(batch.results).toMatchObject([{ issueId: o.issueId, outcome: "dry_run" }]);
      expect(await exists(o.cwd)).toBe(true);
    });

    it("reports and retains unqualified orphan contents", async () => {
      const o = await orphan({ withContents: true });
      const batch = await sweep({ dryRun: true });
      expect(batch.results).toMatchObject([{ issueId: o.issueId, allowedScope: o.cwd,
        outcome: "skipped", reason: "orphan_contents_unqualified",
        requiredEvidence: ["authoritative publication or owned checkpoint for every retained file"] }]);
      expect(batch.results[0]!.candidateBytes).toBeGreaterThan(0);
      expect((await sweep()).results).toMatchObject([{ issueId: o.issueId,
        outcome: "skipped", reason: "orphan_contents_unqualified" }]);
      expect(await exists(o.cwd)).toBe(true);
    });

    it("reports one physical folder when many workspace hints alias it", async () => {
      const o = await orphan({ withContents: true });
      const results = await inspectIsolatedTaskDirectoryFolders(db,
        Array.from({ length: 300 }, () => ({ companyId: o.companyId, issueId: o.issueId })),
        { dryRun: true, now: new Date(), orphanGraceMs: 7 * DAY_MS, terminalDelayMs: 3 * DAY_MS });
      expect(results).toMatchObject([{ companyId: o.companyId, issueId: o.issueId, allowedScope: o.cwd,
        ownerStatus: null, outcome: "skipped", reason: "orphan_contents_unqualified" }]);
      expect(results).toHaveLength(1);
      expect(results[0]!.physicalObject).toBe(`${(await fs.lstat(o.cwd)).dev}:${(await fs.lstat(o.cwd)).ino}`);
      expect(await exists(o.cwd)).toBe(true);
    });

    it("keeps a folder that a live workspace points into", async () => {
      const o = await orphan();
      await db.insert(companies).values({ id: o.companyId, name: "Live", issuePrefix: `LV${o.companyId.slice(0, 6)}` });
      await db.insert(executionWorkspaces).values({ companyId: o.companyId, mode: "shared_workspace", strategyType: "project_primary",
        name: "Live", status: "active", providerType: "local_fs", cwd: path.join(o.cwd, "sub") });
      const batch = await sweep({ dryRun: true });
      expect(batch.results).toMatchObject([{ issueId: o.issueId, allowedScope: o.cwd,
        outcome: "skipped", reason: "live_workspace",
        requiredEvidence: ["settled task, run, lease, and workspace references"] }]);
      expect(await exists(o.cwd)).toBe(true);
    });

    it("removes a folder whose archived row is unbound and whose issue closed long ago", async () => {
      const o = await orphan();
      await db.insert(companies).values({ id: o.companyId, name: "Archived", issuePrefix: `AR${o.companyId.slice(0, 6)}` });
      await db.insert(issues).values({ id: o.issueId, companyId: o.companyId, title: "Old", status: "done", completedAt: new Date(Date.now() - 10 * DAY_MS) });
      await db.insert(executionWorkspaces).values({ companyId: o.companyId, sourceIssueId: o.issueId, mode: "shared_workspace", strategyType: "project_primary",
        name: "Archived", status: "archived", closedAt: new Date(Date.now() - 10 * DAY_MS), providerType: "local_fs", cwd: o.cwd });
      expect((await sweep()).results).toMatchObject([{ outcome: "removed" }]);
      expect(await exists(o.cwd)).toBe(false);
    });

    it("reconciles terminal aliases without closedAt for an empty orphan", async () => {
      const o = await orphan();
      await db.insert(companies).values({ id: o.companyId, name: "Terminal aliases", issuePrefix: `TA${o.companyId.slice(0, 6)}` });
      await db.insert(issues).values({ id: o.issueId, companyId: o.companyId, title: "Old", status: "done",
        completedAt: new Date(Date.now() - 10 * DAY_MS) });
      await db.insert(executionWorkspaces).values((["archived", "cleanup_failed"] as const).map(status => ({
        companyId: o.companyId, sourceIssueId: o.issueId, mode: "shared_workspace", strategyType: "project_primary",
        name: "Terminal alias", status, providerType: "local_fs", cwd: o.cwd,
      })));
      const preview = await sweep({ dryRun: true });
      expect(preview.results).toMatchObject([{ issueId: o.issueId, outcome: "dry_run", ownerStatus: "done" }]);
      expect(preview.results).toHaveLength(1);
      expect(preview.results[0]!.physicalObject).toBe(`${(await fs.lstat(o.cwd)).dev}:${(await fs.lstat(o.cwd)).ino}`);
      expect(await exists(o.cwd)).toBe(true);
      expect((await sweep()).results).toMatchObject([{ issueId: o.issueId, outcome: "removed" }]);
      expect(await exists(o.cwd)).toBe(false);
    });

    it("keeps an empty orphan while another open task selects a terminal alias", async () => {
      const o = await orphan();
      const workspaceId = randomUUID();
      const consumerId = randomUUID();
      await db.insert(companies).values({ id: o.companyId, name: "Selected alias", issuePrefix: `SA${o.companyId.slice(0, 6)}` });
      await db.insert(issues).values({ id: o.issueId, companyId: o.companyId, title: "Old", status: "done",
        completedAt: new Date(Date.now() - 10 * DAY_MS) });
      await db.insert(executionWorkspaces).values({ id: workspaceId, companyId: o.companyId, sourceIssueId: o.issueId,
        mode: "shared_workspace", strategyType: "project_primary", name: "Terminal alias", status: "archived",
        providerType: "local_fs", cwd: o.cwd });
      await db.insert(issues).values({ id: consumerId, companyId: o.companyId, title: "Waiting consumer", status: "todo",
        workspaceSelection: { version: 1, source: "explicit", selection: { kind: "existing", workspaceId } } });
      expect((await sweep({ dryRun: true })).results).toMatchObject([{ issueId: o.issueId, outcome: "skipped",
        reason: "referenced_workspace", requiredEvidence: ["settled task, run, lease, and workspace references"] }]);
      expect(await exists(o.cwd)).toBe(true);
      await db.update(issues).set({ status: "done", completedAt: new Date(Date.now() - 10 * DAY_MS) }).where(eq(issues.id, consumerId));
      expect((await sweep()).results).toMatchObject([{ issueId: o.issueId, outcome: "removed" }]);
    });

    it("keeps an orphan whose issue is still open", async () => {
      const o = await orphan();
      await db.insert(companies).values({ id: o.companyId, name: "Open", issuePrefix: `OP${o.companyId.slice(0, 6)}` });
      await db.insert(issues).values({ id: o.issueId, companyId: o.companyId, title: "Open", status: "todo" });
      expect((await sweep()).results).toMatchObject([{ outcome: "skipped", reason: "issue_open" }]);
      expect(await exists(o.cwd)).toBe(true);
    });

    it("never follows an orphan that is a symbolic link", async () => {
      const companyId = randomUUID(), issueId = randomUUID();
      const parent = path.dirname(await materializeIsolatedTaskDirectory({ companyId, issueId }));
      await fs.rmdir(path.join(parent, issueId));
      await fs.symlink(outside, path.join(parent, issueId));
      expect((await sweep()).results).toMatchObject([{ outcome: "skipped", reason: "unsafe_task_directory" }]);
      expect(await fs.readFile(path.join(outside, "keep.txt"), "utf8")).toBe("outside\n");
    });

    it("preserves an archived bound workspace's surviving folder before removing it, and reopen restores it", async () => {
      const f = await fixture({ status: "archived" });
      const batch = await sweep();
      expect(batch.results).toMatchObject([{ issueId: f.issueId, outcome: "preserved_and_removed", executionWorkspaceId: f.workspaceId }]);
      expect(await exists(f.cwd)).toBe(false);
      expect(await f.ledger()).toMatchObject([{ status: "active" }]);
      expect(await f.reopen()).toMatchObject({ ok: true, reopened: true });
      await expectRestored(f.cwd);
    });

    it("retries an orphan that a live run still uses", async () => {
      const o = await orphan();
      const agentId = randomUUID();
      await db.insert(companies).values({ id: o.companyId, name: "Busy", issuePrefix: `BS${o.companyId.slice(0, 6)}` });
      await db.insert(agents).values({ id: agentId, companyId: o.companyId, name: "Busy agent" });
      await db.insert(issues).values({ id: o.issueId, companyId: o.companyId, title: "Old", status: "done", completedAt: new Date(Date.now() - 10 * DAY_MS) });
      await db.insert(heartbeatRuns).values({ companyId: o.companyId, agentId, status: "running", contextSnapshot: { issueId: o.issueId } });
      const batch = await sweep();
      expect(batch.results).toMatchObject([{ outcome: "skipped", reason: "live_run" }]);
      expect(batch.results[0]!.retryAt).toBeGreaterThan(Date.now());
      expect(await exists(o.cwd)).toBe(true);
    });

    it("finds a folder left by a later archive through workspace change hints", async () => {
      const service = executionWorkspaceService(db, { taskDirectoryRetention: settings, gitRestorePoints: restorePoints() });
      await service.sweepTerminalWorkspaces();
      expect(await service.nextTerminalWorkspaceSweepAt()).toBeNull();
      const f = await fixture({ status: "archived" });
      await service.sweepTerminalWorkspaces();
      expect(await exists(f.cwd)).toBe(true);
      service.terminalWorkspaceWorkSettled(new Set([`workspace:${f.workspaceId}`]));
      expect(await service.nextTerminalWorkspaceSweepAt()).toBeLessThanOrEqual(Date.now());
      await service.sweepTerminalWorkspaces();
      expect(await exists(f.cwd)).toBe(false);
      expect(readTaskDirectoryRetention(await f.row())).toMatchObject({ removed: true });
      expect(await service.nextTerminalWorkspaceSweepAt()).toBeNull();
    });

    it("keeps overflowing folder deadlines discoverable through another walk", async () => {
      const folders = [await orphan({ modifiedDaysAgo: 1 }), await orphan({ modifiedDaysAgo: 1 })];
      let clock = Date.now();
      const service = executionWorkspaceService(db, { taskDirectoryRetention: { ...settings, trackedLimit: 1 },
        gitRestorePoints: restorePoints(), now: () => new Date(clock) });
      await service.sweepTerminalWorkspaces();
      for (const folder of folders) expect(await exists(folder.cwd)).toBe(true);
      const deadline = await service.nextTerminalWorkspaceSweepAt();
      expect(deadline).toBeGreaterThan(clock);
      clock = deadline! + 1000;
      await service.sweepTerminalWorkspaces();
      for (const folder of folders) expect(await exists(folder.cwd)).toBe(false);
    });

    it("returns to a parent's folder when its last open child closes", async () => {
      const service = executionWorkspaceService(db, { taskDirectoryRetention: settings, gitRestorePoints: restorePoints() });
      const f = await fixture({ status: "archived" });
      const childId = randomUUID();
      await db.insert(issues).values({ id: childId, companyId: f.companyId, parentId: f.issueId, title: "Open child", status: "todo" });
      await service.sweepTerminalWorkspaces();
      expect(await exists(f.cwd)).toBe(true);
      await db.update(issues).set({ status: "done", completedAt: new Date(Date.now() - 4 * DAY_MS) }).where(eq(issues.id, childId));
      service.terminalWorkspaceWorkSettled(new Set([`issue:${childId}`]));
      await service.sweepTerminalWorkspaces();
      expect(await exists(f.cwd)).toBe(false);
      expect(readTaskDirectoryRetention(await f.row())).toMatchObject({ removed: true });
    });

    it("keeps an orphan whose closed workspace still has a lease cleanup pending", async () => {
      const o = await orphan();
      await db.insert(companies).values({ id: o.companyId, name: "Lease", issuePrefix: `LS${o.companyId.slice(0, 6)}` });
      const [row] = await db.insert(executionWorkspaces).values({ companyId: o.companyId, mode: "shared_workspace", strategyType: "project_primary",
        name: "Closed", status: "archived", closedAt: new Date(Date.now() - 10 * DAY_MS), providerType: "local_fs", cwd: o.cwd }).returning();
      await db.insert(environmentLeases).values({ companyId: o.companyId, executionWorkspaceId: row!.id, status: "pending_cleanup",
        releasedAt: new Date(Date.now() - 10 * DAY_MS) });
      expect((await sweep()).results).toMatchObject([{ outcome: "skipped", reason: "live_lease" }]);
      expect(await exists(o.cwd)).toBe(true);
    });

    it("bounds the work per sweep and continues from its cursor", async () => {
      const folders = [await orphan(), await orphan(), await orphan()];
      const first = await sweep({ limit: 2 });
      expect(first.results).toHaveLength(2);
      expect(first.next).not.toBeNull();
      const second = await sweep({ limit: 2, after: first.next });
      expect(second.results).toHaveLength(1);
      expect(second.next).toBeNull();
      for (const folder of folders) expect(await exists(folder.cwd)).toBe(false);
    });
  });
});
