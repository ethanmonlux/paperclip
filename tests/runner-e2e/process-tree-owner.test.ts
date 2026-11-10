import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createProcessTreeOwner, stopOwnedProcessTree } from "./process-tree-owner.js";
import { readProcessTable, type ProcessObservation } from "./process-tree.js";
import { runnerE2ETypeScriptProcessArgs } from "./web-server-command.js";

function row(pid: number, parentPid: number, processGroupId: number, started = `start-${pid}`, state = "S"): ProcessObservation {
  return { pid, parentPid, processGroupId, started, state, kind: "node" };
}
function fixture(initial: ProcessObservation[]) {
  let table = [row(process.pid, 1, 10), ...initial];
  const root = { pid: 100, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null };
  const signals: Array<[number, NodeJS.Signals]> = [];
  const owner = createProcessTreeOwner(root as ChildProcess, {
    readTable: async () => table,
    signalGroup: (pid, signal) => { signals.push([pid, signal]); },
  });
  return { root, owner, signals, replace: (rows: ProcessObservation[]) => { table = [row(process.pid, 1, 10), ...rows]; } };
}

it.skipIf(process.platform === "win32")("revalidates PID/start before signaling and refuses a recycled group", async () => {
  const f = fixture([row(100, process.pid, 100), row(200, 100, 200)]);
  try {
    await f.owner.observe();
    f.replace([row(100, process.pid, 100), row(200, 1, 200, "new-start")]);
    await expect(f.owner.signal("SIGKILL")).rejects.toThrow("identity became uncertain");
    expect(f.signals).toEqual([]);
  } finally { f.owner.stopObserving(); }
});

it.skipIf(process.platform === "win32")("keeps surviving peer identities when a descendant traversal ends at a short-lived child", async () => {
  const f = fixture([row(100, process.pid, 100), row(101, 100, 100), row(200, 100, 200), row(201, 200, 200)]);
  try {
    await f.owner.observe();
    await f.owner.observe();
    f.replace([row(100, process.pid, 100), row(200, 100, 200)]);
      await f.owner.signal("SIGKILL");
      expect(f.signals).toEqual([[200, "SIGKILL"], [100, "SIGKILL"]]);
    } finally { f.owner.stopObserving(); }
  });

it.skipIf(process.platform === "win32")("admits replacement group members only through a still-owned ancestor", async () => {
  const f = fixture([row(100, process.pid, 100), row(200, 100, 200)]);
  try {
    await f.owner.observe();
    // The short-lived group leader exited between polls. Its new member is
    // independently owned through the original, still-live controller.
    f.replace([row(100, process.pid, 100), row(300, 100, 200)]);
    await f.owner.signal("SIGKILL");
    expect(f.signals).toEqual([[200, "SIGKILL"], [100, "SIGKILL"]]);
  } finally { f.owner.stopObserving(); }
});

it.skipIf(process.platform === "win32")("keeps surviving peers after the launcher exits without admitting an unobserved group", async () => {
  const f = fixture([row(100, process.pid, 100), row(200, 100, 200), row(201, 200, 200)]);
  try {
    await f.owner.observe();
    f.root.exitCode = 0;
    f.replace([row(200, 1, 200), row(201, 200, 200)]);
    await f.owner.observe();
    f.replace([row(200, 1, 200), row(999, 1, 999)]);
    await f.owner.signal("SIGTERM");
    expect(f.signals).toEqual([[200, "SIGTERM"]]);
    } finally { f.owner.stopObserving(); }
  });

it.skipIf(process.platform === "win32")("refuses replacement groups containing any unowned live member", async () => {
  const f = fixture([row(100, process.pid, 100), row(200, 100, 200)]);
  try {
    await f.owner.observe();
    f.replace([row(100, process.pid, 100), row(300, 100, 200), row(400, 1, 200)]);
    await expect(f.owner.signal("SIGKILL")).rejects.toThrow("identity became uncertain");
    expect(f.signals).toEqual([]);
  } finally { f.owner.stopObserving(); }
});

it.skipIf(process.platform === "win32")("does not use a recycled controller as a replacement member's ownership anchor", async () => {
  const f = fixture([row(100, process.pid, 100), row(200, 100, 200)]);
  try {
    await f.owner.observe();
    f.replace([row(100, process.pid, 100, "recycled-controller"), row(300, 100, 200)]);
    await expect(f.owner.signal("SIGKILL")).rejects.toThrow("identity became uncertain");
    expect(f.signals).toEqual([]);
  } finally { f.owner.stopObserving(); }
});

it.skipIf(process.platform === "win32")("retains observed descendants when the root exits and excludes the caller group", async () => {
  const f = fixture([row(100, process.pid, 100), row(200, 100, 200), row(300, 100, 10), row(999, process.pid, 999)]);
  try {
    await f.owner.observe();
    f.root.exitCode = 1;
    f.replace([row(200, 1, 200), row(300, 1, 10), row(999, process.pid, 999)]);
    await f.owner.signal("SIGTERM");
    expect(f.signals).toEqual([[200, "SIGTERM"]]);
  } finally { f.owner.stopObserving(); }
});

it.skipIf(process.platform === "win32")("treats an unreaped zombie as stopped without signaling a replacement", async () => {
  const f = fixture([row(100, process.pid, 100), row(200, 100, 200)]);
  try {
    await f.owner.observe();
    f.root.exitCode = 1;
    f.replace([row(200, 1, 200, "start-200", "Z")]);
    await f.owner.signal("SIGKILL");
    expect(f.owner.liveGroups()).toEqual([]);
    expect(f.signals).toEqual([]);
  } finally { f.owner.stopObserving(); }
});

it.skipIf(process.platform === "win32")("sends launcher grace only to the root while retaining nested groups for escalation", async () => {
  const f = fixture([row(100, process.pid, 100), row(200, 100, 200), row(300, 200, 300)]);
  try {
    await f.owner.observe();
    await f.owner.signal("SIGTERM", f.owner.gracefulRoots());
    expect(f.signals).toEqual([[100, "SIGTERM"]]);
    f.root.exitCode = 1;
    f.replace([row(200, 1, 200), row(300, 200, 300)]);
    await f.owner.observe();
    expect([...f.owner.gracefulRoots()]).toEqual([200]);
    await f.owner.signal("SIGKILL");
    expect(f.signals.slice(1).map(([pid]) => pid).sort()).toEqual([200, 300]);
  } finally { f.owner.stopObserving(); }
});

it.skipIf(process.platform === 'win32')('reselects a vanished owner only when no graceful signal was delivered', async () => {
  let table = [row(process.pid, 1, 10), row(100, process.pid, 100), row(200, 100, 200)];
  const child = { pid: 100, exitCode: null as number | null, signalCode: null };
  const delivered: number[] = [];
  let reads = 0;
  let stopping = false;
  const owner = createProcessTreeOwner(child as ChildProcess, {
    readTable: async () => {
      if (stopping && ++reads === 2) { child.exitCode = 0; table = [row(process.pid, 1, 10), row(200, 1, 200)]; }
      return table;
    },
    signalGroup: (pid, signal) => {
      expect(signal).toBe('SIGTERM');
      if (pid === 100) {
        child.exitCode = 0; table = [row(process.pid, 1, 10), row(200, 1, 200)];
        throw Object.assign(new Error('vanished'), { code: 'ESRCH' });
      }
      delivered.push(pid); table = [row(process.pid, 1, 10)];
    },
  });
  try {
    await owner.observe(); stopping = true;
    const { stopOwnedProcessTree } = await import('./process-tree-owner.js');
    await stopOwnedProcessTree(child as ChildProcess, owner, 150, 100);
    expect(delivered).toEqual([200]);
  } finally { owner.stopObserving(); }
});


it.skipIf(process.platform === "win32")("rejects an overflowing inspector instead of returning a partial identity table", async () => {
  const inspector = spawn(process.execPath, ["-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024)); setInterval(() => {}, 1000)"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const exited = new Promise<void>(resolve => inspector.once("exit", () => resolve()));
  try {
    expect(await readProcessTable(() => inspector)).toBeNull();
    await exited;
    expect(inspector.signalCode).toBe("SIGKILL");
  } finally { if (inspector.exitCode === null && inspector.signalCode === null) inspector.kill("SIGKILL"); }
});

const psInspector = () => spawn("ps", ["-e", "-o", "pid=,ppid=,pgid=,lstart=,stat=,comm="], {
  env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, stdio: ["ignore", "pipe", "ignore"], detached: true,
});

it.runIf(process.platform === "linux")("reads the identities ps reports without starting an inspector", async () => {
  const [fromProc, fromPs] = [await readProcessTable(), await readProcessTable(psInspector)];
  const identity = (rows: ProcessObservation[] | null, pid: number) => {
    const found = rows?.find(candidate => candidate.pid === pid);
    return found && { pid, parentPid: found.parentPid, processGroupId: found.processGroupId, started: found.started, kind: found.kind };
  };
  for (const pid of [process.pid, process.ppid]) {
    expect(identity(fromProc, pid)).toBeDefined();
    expect(identity(fromProc, pid)).toEqual(identity(fromPs, pid));
  }
});

it.runIf(process.platform === "linux")("keeps inspecting while a launcher signals the caller's process group", async () => {
  // A spawned inspector stays in the caller's group until its setsid(), so a
  // group signal in that window killed it and failed the caller's audit.
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-table-"));
  const reader = path.join(root, "reader.mts");
  await writeFile(reader, `
    import { readProcessTable } from ${JSON.stringify(path.join(import.meta.dirname, "process-tree.ts"))};
    let signals = 0, reads = 0, failed = 0;
    process.on('SIGTERM', () => { signals += 1; });
    process.send!('ready');
    while (signals < 100) { reads += 1; if (!await readProcessTable()) failed += 1; }
    process.send!({ reads, failed }, () => process.exit(0));
  `);
  const child = spawn(process.execPath, runnerE2ETypeScriptProcessArgs(path.resolve(import.meta.dirname, "../.."), reader), {
    detached: true, stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  try {
    await once(child, "message");
    const result = once(child, "message");
    let done = false;
    void result.finally(() => { done = true; });
    while (!done && child.exitCode === null) {
      process.kill(-child.pid!, "SIGTERM");
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    const [{ reads, failed }] = await result;
    expect(reads).toBeGreaterThan(0);
    expect(failed).toBe(0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid!, "SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === 'win32')('bounds fallback even when the known direct child cannot be killed', async () => {
  const signals: NodeJS.Signals[] = [];
  const child = { pid: 100, exitCode: null, signalCode: null,
    kill: (signal: NodeJS.Signals) => { signals.push(signal); return false; } } as ChildProcess;
  const owner = createProcessTreeOwner(child, { readTable: async () => null,
    signalGroup: () => { throw new Error('must not signal an unobserved group'); } });
  try {
    const { stopOwnedProcessTree } = await import('./process-tree-owner.js');
    await expect(stopOwnedProcessTree(child, owner, 10, 10)).rejects.toThrow('Known direct child remained');
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  } finally { owner.stopObserving(); }
});

function epermFixture(afterSignal: ProcessObservation[]) {
  let table = [row(process.pid, 1, 10), row(100, process.pid, 100), row(200, 100, 200)];
  const root = { pid: 100, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null };
  const attempts: Array<[number, NodeJS.Signals]> = [];
  const owner = createProcessTreeOwner(root as ChildProcess, {
    readTable: async () => table,
    signalGroup: (pid, signal) => {
      attempts.push([pid, signal]);
      if (pid !== 200) return;
      // Darwin killpg reports EPERM, not ESRCH, once every group member exited
      // but is not reaped yet. The group exits between inspection and signal.
      table = [row(process.pid, 1, 10), row(100, process.pid, 100), ...afterSignal];
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    },
  });
  return { owner, attempts };
}

it.skipIf(process.platform === "win32")("treats EPERM from a group that is now only zombies as already exited", async () => {
  const f = epermFixture([row(200, 100, 200, "start-200", "Z")]);
  try {
    await f.owner.observe();
    await expect(f.owner.signal("SIGKILL")).resolves.toEqual([100]);
    expect(f.attempts).toEqual([[200, "SIGKILL"], [100, "SIGKILL"]]);
  } finally { f.owner.stopObserving(); }
});

it.skipIf(process.platform === "win32")("keeps EPERM fatal while the group still has a running member", async () => {
  const f = epermFixture([row(200, 100, 200, "start-200", "Z"), row(201, 200, 200)]);
  try {
    await f.owner.observe();
    await expect(f.owner.signal("SIGKILL")).rejects.toThrow("kill EPERM");
  } finally { f.owner.stopObserving(); }
});

function turnoverFixture(uncertainReads: number) {
  // Server 100 owns runner group 200. Between two inspections the observed
  // runner exits and a straggler nobody saw start (201) is left in group 200,
  // reparented to init: its identity is unproven, so it must never be signaled.
  const settledTable = () => [row(process.pid, 1, 10)];
  let table = [row(process.pid, 1, 10), row(100, process.pid, 100), row(200, 100, 200)];
  const killed: NodeJS.Signals[] = [];
  const signals: Array<[number, NodeJS.Signals]> = [];
  const child = { pid: 100, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    kill: (signal: NodeJS.Signals) => { killed.push(signal); return true; } };
  let stopping = false;
  let uncertain = 0;
  const owner = createProcessTreeOwner(child as unknown as ChildProcess, {
    readTable: async () => {
      if (!stopping) return table;
      if (uncertain < uncertainReads) {
        uncertain += 1;
        return [row(process.pid, 1, 10), row(201, 1, 200, "unseen-start")];
      }
      child.exitCode = 0;
      return settledTable();
    },
    signalGroup: (pid, signal) => { signals.push([pid, signal]); },
  });
  return { owner, child: child as unknown as ChildProcess, signals, killed, stop: () => { stopping = true; table = settledTable(); } };
}

it.skipIf(process.platform === "win32")("waits out a briefly uncertain group under load without signaling it", async () => {
  const f = turnoverFixture(3);
  try {
    await f.owner.observe();
    f.stop();
    await stopOwnedProcessTree(f.child, f.owner, 2_000, 500);
    expect(f.signals.filter(([pid]) => pid === 200)).toEqual([]);
    expect(f.killed).toEqual([]);
  } finally { f.owner.stopObserving(); }
});

it.skipIf(process.platform === "win32")("still fails without signaling the uncertain group when the uncertainty outlasts the deadline", async () => {
  const f = turnoverFixture(Number.POSITIVE_INFINITY);
  try {
    await f.owner.observe();
    f.stop();
    await expect(stopOwnedProcessTree(f.child, f.owner, 300, 100)).rejects.toThrow("identity became uncertain");
    expect(f.signals).toEqual([]);
  } finally { f.owner.stopObserving(); }
});

it.skipIf(process.platform === "win32")("keeps an uncertainty that starts at SIGKILL escalation inside one forced window", async () => {
  // The launcher ignores grace; its runner group turns over only once grace has expired.
  const gracefulMs = 300, forcedMs = 300;
  const self = row(process.pid, 1, 10);
  let stopAt: number | null = null;
  const signals: Array<[number, NodeJS.Signals]> = [];
  const child = { pid: 100, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, kill: () => true };
  const owner = createProcessTreeOwner(child as unknown as ChildProcess, {
    readTable: async () => stopAt === null || Date.now() - stopAt < gracefulMs
      ? [self, row(100, process.pid, 100), row(200, 100, 200)]
      : [self, row(100, process.pid, 100), row(201, 1, 200, "unseen-start")],
    signalGroup: (pid, signal) => { signals.push([pid, signal]); },
  });
  try {
    await owner.observe();
    stopAt = Date.now();
    await expect(stopOwnedProcessTree(child as unknown as ChildProcess, owner, gracefulMs, forcedMs)).rejects.toThrow("identity became uncertain");
    const elapsed = Date.now() - stopAt;
    expect(elapsed).toBeLessThan(gracefulMs + forcedMs + 250);
    expect(signals.filter(([, signal]) => signal === "SIGKILL")).toEqual([]);
  } finally { owner.stopObserving(); }
});
