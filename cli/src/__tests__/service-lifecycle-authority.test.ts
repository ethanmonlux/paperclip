import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flipCurrentAtomic, initializeInstallStore, payloadPathFor, readInstallManifest, resolveInstallStorePaths, writeInstallManifestAtomic, type InstallRecord } from "../install-store.js";
import { installCommand, type CommandRunner } from "../commands/install.js";
import { updateCommand } from "../commands/update.js";
import { uninstallCommand } from "../commands/uninstall.js";
import {
  assertServiceLifecycleOutsideAgentRun,
  assertServiceLifecycleQuiet,
  countActiveServiceRuns,
  ServiceLifecycleRefusedError,
} from "../service-lifecycle-authority.js";
import type { ServiceManager, ServiceManagerDetection } from "../services/service-manager.js";

let root: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["HOME", "PAPERCLIP_HOME", "PAPERCLIP_RUN_ID", "PAPERCLIP_AGENT_ID"] as const;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-lifecycle-"));
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.HOME = path.join(root, "home");
  process.env.PAPERCLIP_HOME = path.join(root, "paperclip");
  // The suite itself may run inside an agent run; each test sets what it needs.
  delete process.env.PAPERCLIP_RUN_ID;
  delete process.env.PAPERCLIP_AGENT_ID;
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(root, { recursive: true, force: true });
  process.exitCode = undefined;
});

function record(payloadPath: string, version: string): InstallRecord {
  return { source: "npm", version, channel: "latest", payloadPath, installedAt: `2026-07-22T00:00:0${version}.000Z` };
}
function createPayload(payloadPath: string, version: string): string {
  const entrypoint = path.join(payloadPath, "node_modules", "paperclipai", "dist", "index.js");
  fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
  fs.writeFileSync(entrypoint, version);
  return entrypoint;
}
/** A managed install on 2.0.0 with 1.0.0 available for rollback. */
function managedInstall() {
  const paths = resolveInstallStorePaths(); initializeInstallStore(paths);
  const oldPayload = payloadPathFor(paths, "npm", "1.0.0"); createPayload(oldPayload, "1.0.0");
  const payload = payloadPathFor(paths, "npm", "2.0.0"); const executablePath = createPayload(payload, "2.0.0");
  flipCurrentAtomic(payload, paths);
  writeInstallManifestAtomic({ schemaVersion: 1, ...record(payload, "2.0.0"), previous: [record(oldPayload, "1.0.0")] }, paths);
  return { paths, executablePath, payload, oldPayload };
}
function detection(active: boolean | null): () => Promise<ServiceManagerDetection> {
  if (active === null) return async () => ({ supported: false, reason: "no systemd user manager" });
  const manager = { status: async () => ({ active }) } as unknown as ServiceManager;
  return async () => ({ supported: true, manager });
}

describe("service lifecycle authority", () => {
  it("refuses lifecycle actions inside an agent run", () => {
    expect(() => assertServiceLifecycleOutsideAgentRun("install Paperclip", { PAPERCLIP_RUN_ID: "run-1" }))
      .toThrow("Refusing to install Paperclip from inside an agent run (PAPERCLIP_RUN_ID is set)");
    expect(() => assertServiceLifecycleOutsideAgentRun("restart", { PAPERCLIP_AGENT_ID: "agent-1" }))
      .toThrow(ServiceLifecycleRefusedError);
    expect(() => assertServiceLifecycleOutsideAgentRun("restart", { PAPERCLIP_RUN_ID: "  " })).not.toThrow();
    expect(() => assertServiceLifecycleOutsideAgentRun("restart", {})).not.toThrow();
  });

  it("counts running runs only for an active managed service", async () => {
    const countRunning = vi.fn(async () => 3);
    await expect(countActiveServiceRuns({ detect: detection(null), countRunning })).resolves.toBe(0);
    // A stopped service has no live runs: stale rows never block its recovery.
    await expect(countActiveServiceRuns({ detect: detection(false), countRunning })).resolves.toBe(0);
    expect(countRunning).not.toHaveBeenCalled();
    await expect(countActiveServiceRuns({ detect: detection(true), countRunning })).resolves.toBe(3);
    await expect(countActiveServiceRuns({ detect: detection(true), countRunning: async () => null })).resolves.toBe(0);
  });

  it("refuses while the active service has running runs and has no override", async () => {
    await expect(assertServiceLifecycleQuiet("restart the Paperclip service", async () => 0)).resolves.toBeUndefined();
    const refusal = assertServiceLifecycleQuiet("restart the Paperclip service", async () => 1);
    await expect(refusal).rejects.toThrow("Refusing to restart the Paperclip service while 1 agent run is running on the active service.");
    await expect(refusal).rejects.toMatchObject({ reason: "runs_active" });
  });
});

describe("install under lifecycle authority", () => {
  it("refuses an install scheduled from an agent run under 6 live runs (STA-167) before any install work", async () => {
    const runCommand = vi.fn<CommandRunner>();
    const activeServiceRuns = vi.fn(async () => 6);
    await expect(installCommand({ repo: "ethanmonlux/paperclip", ref: "master", yes: true }, {
      runCommand, activeServiceRuns, env: { PAPERCLIP_RUN_ID: "run-1" },
    })).rejects.toThrow("from inside an agent run");
    // The same install from the operator's shell still waits for quiet.
    await expect(installCommand({ repo: "ethanmonlux/paperclip", ref: "master", yes: true }, {
      runCommand, activeServiceRuns, env: {},
    })).rejects.toThrow("while 6 agent runs are running");
    expect(runCommand).not.toHaveBeenCalled();
  });
});

describe("update under lifecycle authority", () => {
  it("refuses a payload update while runs are active, before backup or install", async () => {
    const { paths, executablePath } = managedInstall();
    const before = readInstallManifest(paths);
    const runCommand = vi.fn<CommandRunner>(async () => ({ stdout: "\"3.0.0\"\n", stderr: "" }));
    const backup = vi.fn(async () => undefined);
    const restartActiveService = vi.fn(async () => true);
    await expect(updateCommand({ yes: true }, {
      paths, executablePath, runCommand, backup, restartActiveService, activeServiceRuns: async () => 2, hasInstanceData: () => true,
    })).rejects.toThrow("Refusing to update Paperclip while 2 agent runs are running");
    expect(backup).not.toHaveBeenCalled();
    expect(restartActiveService).not.toHaveBeenCalled();
    expect(runCommand.mock.calls.every(([, args]) => !(args as string[]).includes("install"))).toBe(true);
    expect(readInstallManifest(paths)).toEqual(before);
  });

  it("rolls the payload back under active runs but defers the restart", async () => {
    const { paths, executablePath, oldPayload } = managedInstall();
    const restartActiveService = vi.fn(async () => true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await updateCommand({ rollback: true, yes: true }, { paths, executablePath, restartActiveService, activeServiceRuns: async () => 4 });
    expect(readInstallManifest(paths)?.version).toBe("1.0.0");
    expect(fs.realpathSync(paths.currentPath)).toBe(fs.realpathSync(oldPayload));
    expect(restartActiveService).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Restart deferred: 4 agent runs are running"));
  });

  it("restarts after a rollback once the instance is quiet", async () => {
    const { paths, executablePath } = managedInstall();
    const restartActiveService = vi.fn(async () => true);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await updateCommand({ rollback: true, yes: true }, { paths, executablePath, restartActiveService, activeServiceRuns: async () => 0 });
    expect(restartActiveService).toHaveBeenCalledWith("1.0.0");
  });

  it("refuses a rollback from inside an agent run without touching the payload", async () => {
    const { paths, executablePath, payload } = managedInstall();
    const restartActiveService = vi.fn(async () => true);
    await expect(updateCommand({ rollback: true, yes: true }, {
      paths, executablePath, restartActiveService, activeServiceRuns: async () => 0, env: { PAPERCLIP_AGENT_ID: "agent-1" },
    })).rejects.toThrow("Refusing to roll back Paperclip from inside an agent run");
    expect(readInstallManifest(paths)?.version).toBe("2.0.0");
    expect(fs.realpathSync(paths.currentPath)).toBe(fs.realpathSync(payload));
    expect(restartActiveService).not.toHaveBeenCalled();
  });

  it("keeps checks and dry runs available inside agent runs", async () => {
    const { paths, executablePath } = managedInstall();
    const runCommand = vi.fn(async () => ({ stdout: "\"3.0.0\"\n", stderr: "" }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const env = { PAPERCLIP_RUN_ID: "run-1" };
    await updateCommand({ check: true }, { paths, executablePath, runCommand, env, activeServiceRuns: async () => 5 });
    await updateCommand({ dryRun: true }, { paths, executablePath, runCommand, env, activeServiceRuns: async () => 5 });
    await updateCommand({ rollback: true, dryRun: true }, { paths, executablePath, env, activeServiceRuns: async () => 5 });
    expect(readInstallManifest(paths)?.version).toBe("2.0.0");
  });
});

describe("uninstall under lifecycle authority", () => {
  it("refuses a top-level uninstall while runs are active, before stopping the service or removing the payload", async () => {
    const { paths, payload } = managedInstall();
    const uninstall = vi.fn(async () => undefined);
    const manager = { status: async () => ({ installed: true, active: true }), uninstall } as unknown as ServiceManager;
    const countRunning = vi.fn(async () => 6);
    await expect(uninstallCommand({
      detectServiceManager: async () => ({ supported: true, manager }),
      platform: "linux",
      userHomeDir: path.join(root, "home"),
      activeServiceRuns: () => countActiveServiceRuns({ detect: async () => ({ supported: true, manager }), countRunning }),
    })).rejects.toThrow("Refusing to uninstall Paperclip while 6 agent runs are running");
    expect(countRunning).toHaveBeenCalledTimes(1);
    expect(uninstall).not.toHaveBeenCalled();
    expect(fs.existsSync(payload)).toBe(true);
    expect(fs.existsSync(paths.cliRoot)).toBe(true);
  });

  it("uninstalls once the service is quiet", async () => {
    const { paths } = managedInstall();
    const uninstall = vi.fn(async () => undefined);
    const manager = { status: async () => ({ installed: true, active: true }), uninstall } as unknown as ServiceManager;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await uninstallCommand({
      detectServiceManager: async () => ({ supported: true, manager }),
      platform: "linux",
      userHomeDir: path.join(root, "home"),
      activeServiceRuns: async () => 0,
    });
    expect(uninstall).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(paths.cliRoot)).toBe(false);
  });
});
