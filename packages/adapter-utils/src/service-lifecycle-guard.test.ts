import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildLocalProcessSandboxSpawnTarget, type LocalProcessSandboxOptions } from "./local-process-sandbox.js";
import { runChildProcess } from "./server-utils.js";
import {
  buildServiceLifecycleGuardArgs,
  mountReachesServiceLifecycleGuard,
  resolveServiceLifecycleGuardPaths,
  type ServiceLifecycleGuardPath,
} from "./service-lifecycle-guard.js";

const cleanup: string[] = [];
const servers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(cleanup.splice(0).map((candidate) => fs.rm(candidate, { recursive: true, force: true })));
});

/**
 * A fake host account laid out like the Staple service user: a user runtime
 * dir with a live bus socket, the CLI board credential, the managed install
 * store, the command shims and the systemd user units.
 */
async function fakeServiceAccount() {
  const root = await fs.mkdtemp(path.join("/tmp", "pc-lifecycle-"));
  cleanup.push(root);
  const home = path.join(root, "home");
  const runtimeDir = path.join(root, "run-user");
  const workspace = path.join(home, "workspace");
  const authFile = path.join(home, ".paperclip", "auth.json");
  const cliStore = path.join(home, ".paperclip", "cli");
  const shimDir = path.join(home, ".local", "bin");
  const systemdDir = path.join(home, ".config", "systemd");
  for (const dir of [runtimeDir, workspace, cliStore, shimDir, systemdDir]) await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(authFile, "{\"token\":\"board-secret\"}", "utf8");
  await fs.writeFile(path.join(cliStore, "payload.txt"), "payload", "utf8");
  await fs.writeFile(path.join(shimDir, "staple-nightly-upgrade"), "#!/bin/sh\n", "utf8");
  await fs.writeFile(path.join(home, "notes.txt"), "notes", "utf8");
  const busSocket = path.join(runtimeDir, "bus");
  const server = net.createServer((socket) => socket.end("bus"));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(busSocket, resolve));
  const guards = resolveServiceLifecycleGuardPaths({ homeDirs: [home], paperclipHome: null, uid: null, env: { XDG_RUNTIME_DIR: runtimeDir } });
  return { root, home, runtimeDir, workspace, authFile, cliStore, shimDir, systemdDir, busSocket, guards };
}

function guardArgPairs(args: string[]): string[][] {
  const start = args.indexOf("--chdir");
  const pairs: string[][] = [];
  for (let index = 0; index < start; index += 1) {
    if (args[index] === "--tmpfs") pairs.push(["--tmpfs", args[index + 1]!]);
    if (args[index] === "--ro-bind") pairs.push(["--ro-bind", args[index + 1]!, args[index + 2]!]);
    if (args[index] === "--bind") pairs.push(["--bind", args[index + 1]!, args[index + 2]!]);
  }
  return pairs;
}

describe("service lifecycle guard paths", () => {
  it("covers the runtime dir, board credential, install store, shims and systemd units", () => {
    const guards = resolveServiceLifecycleGuardPaths({
      homeDirs: ["/home/svc"],
      paperclipHome: "/srv/paperclip",
      uid: 1000,
      env: { XDG_RUNTIME_DIR: "/run/user/1000", XDG_CONFIG_HOME: "/home/svc/.config" },
    });
    expect(guards).toEqual([
      { path: "/run/user/1000", protect: "hide" },
      { path: "/srv/paperclip/auth.json", protect: "hide" },
      { path: "/home/svc/.paperclip/auth.json", protect: "hide" },
      { path: "/srv/paperclip/cli", protect: "read_only" },
      { path: "/home/svc/.paperclip/cli", protect: "read_only" },
      { path: "/home/svc/.local/bin", protect: "read_only" },
      { path: "/home/svc/.config/systemd", protect: "read_only" },
    ]);
  });

  it("treats an ancestor, the path itself and a descendant as reaching a guard", () => {
    const hide: ServiceLifecycleGuardPath = { path: "/run/user/1000", protect: "hide" };
    const readOnly: ServiceLifecycleGuardPath = { path: "/home/svc/.local/bin", protect: "read_only" };
    // A read-only bind still lets a run connect to the bus socket.
    expect(mountReachesServiceLifecycleGuard({ path: "/run/user/1000/bus", access: "ro" }, hide)).toBe(true);
    expect(mountReachesServiceLifecycleGuard({ path: "/run", access: "ro" }, hide)).toBe(true);
    expect(mountReachesServiceLifecycleGuard({ path: "/run/user/1001", access: "rw" }, hide)).toBe(false);
    expect(mountReachesServiceLifecycleGuard({ path: "/home/svc", access: "rw" }, readOnly)).toBe(true);
    expect(mountReachesServiceLifecycleGuard({ path: "/home/svc", access: "ro" }, readOnly)).toBe(false);
    expect(mountReachesServiceLifecycleGuard({ path: "/home/svc/.local/bin/tool", access: "rw" }, readOnly)).toBe(true);
    expect(mountReachesServiceLifecycleGuard({ path: "/home/svc/.local/binary", access: "rw" }, readOnly)).toBe(false);
  });

  it("re-covers only reached guards and skips paths missing on the host", async () => {
    const account = await fakeServiceAccount();
    const args = await buildServiceLifecycleGuardArgs({
      mounts: [{ path: account.home, access: "ro" }],
      guards: [...account.guards, { path: path.join(account.root, "missing"), protect: "hide" }],
    });
    // The read-only home bind reaches the credential but cannot write the
    // install store, shims or units, and does not reach the runtime dir.
    expect(args).toEqual(["--ro-bind", "/dev/null", account.authFile]);
  });
});

describe.runIf(process.platform === "linux")("sandbox service lifecycle authority", () => {
  it("re-covers lifecycle paths that agent extra paths would expose, after every other mount", async () => {
    const account = await fakeServiceAccount();
    const target = await buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: account.workspace,
      options: {
        workspaceDir: account.workspace,
        filesystemScope: "workspace",
        extraPaths: [
          { path: account.busSocket, access: "ro" },
          { path: account.home, access: "rw" },
        ],
        outboundRestorePaths: [account.home],
        serviceLifecycleGuards: account.guards,
      },
    });
    const pairs = guardArgPairs(target.args);
    const guardStart = pairs.findIndex((pair) => pair[0] === "--tmpfs" && pair[1] === account.runtimeDir);
    expect(guardStart).toBeGreaterThan(pairs.findIndex((pair) => pair[0] === "--bind" && pair[1] === account.workspace));
    expect(pairs.slice(guardStart)).toEqual([
      ["--tmpfs", account.runtimeDir],
      ["--ro-bind", "/dev/null", account.authFile],
      ["--ro-bind", account.cliStore, account.cliStore],
      ["--ro-bind", account.shimDir, account.shimDir],
      ["--ro-bind", account.systemdDir, account.systemdDir],
    ]);
  });

  it("re-covers lifecycle paths when network-only confinement binds the host root", async () => {
    const account = await fakeServiceAccount();
    const target = await buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: account.workspace,
      options: { workspaceDir: account.workspace, networkScope: "deny", serviceLifecycleGuards: account.guards },
    });
    const pairs = guardArgPairs(target.args);
    expect(pairs[0]).toEqual(["--bind", "/", "/"]);
    expect(pairs.slice(1)).toEqual([
      ["--tmpfs", account.runtimeDir],
      ["--ro-bind", "/dev/null", account.authFile],
      ["--ro-bind", account.cliStore, account.cliStore],
      ["--ro-bind", account.shimDir, account.shimDir],
      ["--ro-bind", account.systemdDir, account.systemdDir],
    ]);
  });

  it("adds nothing when the confined run cannot reach any lifecycle path", async () => {
    const account = await fakeServiceAccount();
    const target = await buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: account.workspace,
      options: { workspaceDir: account.workspace, filesystemScope: "workspace", serviceLifecycleGuards: account.guards },
    });
    expect(target.args).not.toContain(account.runtimeDir);
    expect(target.args).not.toContain(account.authFile);
  });
});

const lifecycleProbe = (account: Awaited<ReturnType<typeof fakeServiceAccount>>) => [
  "const fs = require('node:fs');",
  "const net = require('node:net');",
  "const results = {};",
  "const tryWrite = (file) => { try { fs.writeFileSync(file, 'x'); return 'written'; } catch (error) { return error.code; } };",
  `results.auth = (() => { try { return fs.readFileSync(${JSON.stringify(account.authFile)}, 'utf8'); } catch (error) { return error.code; } })();`,
  `results.cliRead = fs.readFileSync(${JSON.stringify(path.join(account.cliStore, "payload.txt"))}, 'utf8');`,
  `results.cliWrite = tryWrite(${JSON.stringify(path.join(account.cliStore, "payload.txt"))});`,
  `results.shimWrite = tryWrite(${JSON.stringify(path.join(account.shimDir, "staple-nightly-upgrade"))});`,
  `results.unitWrite = tryWrite(${JSON.stringify(path.join(account.systemdDir, "paperclipai.service"))});`,
  `results.homeWrite = tryWrite(${JSON.stringify(path.join(account.home, "notes.txt"))});`,
  `const socket = net.connect(${JSON.stringify(account.busSocket)});`,
  "socket.on('data', () => { results.bus = 'connected'; socket.destroy(); });",
  "socket.on('error', (error) => { results.bus = error.code; });",
  "socket.on('close', () => { console.log(JSON.stringify(results)); });",
].join("\n");

describe.runIf(Boolean(process.env.PAPERCLIP_TEST_BWRAP))("sandbox service lifecycle authority under bubblewrap", () => {
  const cases: Array<{ name: string; options: (account: Awaited<ReturnType<typeof fakeServiceAccount>>) => LocalProcessSandboxOptions }> = [
    {
      name: "workspace confinement with the home and bus socket added as extra paths",
      options: (account) => ({
        workspaceDir: account.workspace,
        filesystemScope: "workspace",
        extraPaths: [{ path: account.busSocket, access: "ro" }, { path: account.home, access: "rw" }],
        outboundRestorePaths: [account.home],
      }),
    },
    {
      name: "network-only confinement that binds the host root",
      options: (account) => ({ workspaceDir: account.workspace, networkScope: "deny" }),
    },
  ];

  for (const testCase of cases) {
    it(`blocks the bus, credential and install paths for ${testCase.name}`, async () => {
      const account = await fakeServiceAccount();
      const result = await runChildProcess("lifecycle-guard-test", process.execPath, ["-e", lifecycleProbe(account)], {
        cwd: account.workspace,
        env: {},
        timeoutSec: 10,
        graceSec: 1,
        onLog: async () => {},
        localProcessSandbox: {
          ...testCase.options(account),
          serviceLifecycleGuards: account.guards,
          command: process.env.PAPERCLIP_TEST_BWRAP,
        },
      });
      expect(result.exitCode, result.stderr).toBe(0);
      const observed = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
      // The credential is covered by /dev/null: empty, or EACCES where the
      // outer host mounts /dev nodev. Never the secret.
      expect(["", "EACCES"]).toContain(observed.auth);
      expect({ ...observed, auth: "covered" }).toEqual({
        auth: "covered",
        cliRead: "payload",
        cliWrite: "EROFS",
        shimWrite: "EROFS",
        unitWrite: "EROFS",
        homeWrite: "written",
        bus: "ENOENT",
      });
      // The host side is untouched.
      await expect(fs.readFile(account.authFile, "utf8")).resolves.toContain("board-secret");
    });
  }
});
