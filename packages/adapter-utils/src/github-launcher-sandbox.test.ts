import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { githubOperationLauncherDirectory, localGitHubLauncherSandboxPaths, prepareGitHubOperationLaunchers, cleanupGitHubOperationLaunchers } from "./execution-target.js";
import { runChildProcess } from "./server-utils.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
describe("local managed GitHub launcher sandbox", () => {
  it("does not mount arbitrary configured directories or another run", async () => {
    const runId = randomUUID();
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), "launcher-foreign-")); dirs.push(elsewhere);
    expect(await localGitHubLauncherSandboxPaths({ runId, env: { PAPERCLIP_GITHUB_LAUNCHER_DIR: elsewhere } })).toEqual([]);
    expect(await localGitHubLauncherSandboxPaths({ runId, env: { PAPERCLIP_GITHUB_LAUNCHER_DIR: githubOperationLauncherDirectory({ runId: randomUUID(), target: null }) } })).toEqual([]);
  });
  it.runIf(process.platform !== "win32")("rejects a symlink instead of mounting a different host directory", async () => {
    const runId = randomUUID(), directory = githubOperationLauncherDirectory({ runId, target: null });
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), "launcher-symlink-")); dirs.push(elsewhere, directory);
    await mkdir(path.dirname(directory), { recursive: true }); await symlink(elsewhere, directory, "dir");
    await expect(localGitHubLauncherSandboxPaths({ runId, env: { PAPERCLIP_GITHUB_LAUNCHER_DIR: directory } })).rejects.toThrow("not canonical");
  });
  it("returns only the canonical run-scoped launcher directory", async () => {
    const runId = randomUUID(), directory = githubOperationLauncherDirectory({ runId, target: null }); dirs.push(directory);
    await mkdir(directory, { recursive: true });
    expect(await localGitHubLauncherSandboxPaths({ runId, env: { PAPERCLIP_GITHUB_LAUNCHER_DIR: directory } })).toEqual([{ path: directory, access: "rw" }]);
  });
  it.runIf(Boolean(process.env.PAPERCLIP_TEST_BWRAP))("keeps the real wrapper and authenticated broker reachable through the confined proxy", async () => {
    const runId = randomUUID(); const root = await mkdtemp(path.join(os.tmpdir(), "launcher-confined-")); dirs.push(root);
    const cwd = path.join(root, "workspace"); await mkdir(cwd); const outside = path.join(root, "outside.txt"); await writeFile(outside, "must remain inaccessible");
    let calls = 0;
    const server = http.createServer((req, res) => {
      if (req.url !== "/runtime-tools/github/credentials" || req.headers.authorization !== "Bearer test-own-run" || req.headers["x-paperclip-github-capability"] !== "test-operation-capability") { res.writeHead(403); res.end(); return; }
      calls++; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ status: "available", env: {} }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); if (!address || typeof address === "string") throw Error("No server");
    const url = `http://127.0.0.1:${address.port}`;
    const env = await prepareGitHubOperationLaunchers({ runId, target: null, cwd, env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, NODE_USE_ENV_PROXY: "1", PAPERCLIP_API_URL: url, PAPERCLIP_API_KEY: "test-own-run", PAPERCLIP_GITHUB_BROKER_TOKEN: "test-operation-capability" } });
    try {
      const result = await runChildProcess("managed-launcher-confined-test", "/bin/bash", ["-c", `git --version && test ! -e '${outside}'`], { cwd, env, timeoutSec: 20, graceSec: 1, onLog: async () => {}, localProcessSandbox: { workspaceDir: cwd, filesystemScope: "workspace", networkScope: "allowlist", networkAllowlist: [], networkTrustedUrls: [url], managedPaths: await localGitHubLauncherSandboxPaths({ runId, env }), extraPaths: [{ path: path.dirname(process.execPath), access: "ro" }], command: process.env.PAPERCLIP_TEST_BWRAP } });
      expect(result.exitCode, result.stderr).toBe(0); expect(result.stdout).toContain("git version"); expect(calls).toBe(1);
    } finally { await cleanupGitHubOperationLaunchers({ runId, target: null }); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
