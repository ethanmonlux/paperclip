import { describe, expect, it } from "vitest";
import {
  buildStapleConsoleUpgradeStatus,
  stapleUpgradeLocalToIso,
  type StapleConsoleUpgradeInput,
  type StapleUpgradeLogFile,
} from "./staple-console-upgrade.js";

// Installer lines as `staple-nightly-upgrade.sh` writes them: `[%F %T] message`, host time (MST here).
const TZ = "America/Denver";
const INSTALLED = "69187fe6a1b2c3d4e5f60718293a4b5c6d7e8f90";
const TARGET = "92585ac285dcea110b7f6f5310eea17842b850b9";

function log(name: string, lines: string[], modifiedAt: string): StapleUpgradeLogFile {
  return { name, text: `${lines.join("\n")}\n`, modifiedAt };
}

const start = [
  "[2026-11-13 03:30:01] == Staple nightly upgrade (dry=0 quiet=0)",
  `[2026-11-13 03:30:03] installed=${INSTALLED} master=${TARGET}`,
  `[2026-11-13 03:30:05] certified target: target:${TARGET} installed-in-chain:yes`,
  "[2026-11-13 03:30:07] CI on target: green",
  "[2026-11-13 03:30:08] maintenance hold active since 2026-11-13T09:30:00.000Z; park at 2026-11-13T10:15:00.000Z; auto-release by 2026-11-13T11:00:00.000Z; queued=4 running=2",
];
const drained = [
  ...start,
  "[2026-11-13 03:30:08] running or settling work: 2 (queued work is held)",
  "[2026-11-13 03:31:08] running or settling work: 0 (queued work is held)",
];
const backedUp = [...drained, "[2026-11-13 03:31:40] backup: file:/home/paperclip/.paperclip/backups/staple-nightly-pre-92585ac2.sql.gz"];
const installing = [...backedUp, "[2026-11-13 03:31:41] installing 92585ac2"];

function input(logs: StapleUpgradeLogFile[] | null, overrides: Partial<StapleConsoleUpgradeInput> = {}): StapleConsoleUpgradeInput {
  return {
    now: "2026-11-13T10:40:00.000Z",
    timeZone: TZ,
    logs,
    hold: null,
    installedBuild: "69187fe6",
    serverStartedAt: "2026-11-12T19:00:00.000Z",
    nextNightlyAt: "2026-11-14T10:30:00.000Z",
    ...overrides,
  };
}

describe("stapleUpgradeLocalToIso", () => {
  it("reads installer timestamps in the host zone", () => {
    expect(stapleUpgradeLocalToIso([2026, 11, 13, 3, 30, 1], TZ)).toBe("2026-11-13T10:30:01.000Z");
    expect(stapleUpgradeLocalToIso([2026, 7, 1, 3, 30, 0], TZ)).toBe("2026-07-01T09:30:00.000Z");
  });
});

describe("buildStapleConsoleUpgradeStatus", () => {
  it("shows a verified completion with every stage done", () => {
    const status = buildStapleConsoleUpgradeStatus(input([
      log("upgrade-20261113-0330.log", [
        ...installing,
        "[2026-11-13 03:44:10] verify: health commit 92585ac285dcea110b7f6f5310eea17842b850b9, startup logged",
        "[2026-11-13 03:44:12] smoke: agents=12 issues=1",
        "[2026-11-13 03:44:12] maintenance hold released (upgraded to 92585ac2): HTTP 200 wasActive=True queued=4",
        "[2026-11-13 03:44:13] REPORT: Upgraded Staple 69187fe6 -> 92585ac2",
      ], "2026-11-13T10:44:13.000Z"),
    ], { installedBuild: "92585ac", serverStartedAt: "2026-11-13T10:43:30.000Z" }));
    expect(status.phase).toBe("verified");
    expect(status.headline).toBe("Installed 92585ac2, verified");
    expect(status.installed).toBe("92585ac");
    expect(status.stages.every((cell) => cell.state === "done")).toBe(true);
    expect(status.attemptStartedAt).toBe("2026-11-13T10:30:01.000Z");
    expect(status.attemptEndedAt).toBe("2026-11-13T10:44:13.000Z");
    expect(status.needsEthan).toBeNull();
    expect(status.nextAction).toBe("Next check: the 03:30 nightly attempt");
  });

  it("shows draining with the running count and the hold", () => {
    const hold = {
      since: "2026-11-13T09:30:00.000Z", drainDeadlineAt: "2026-11-13T10:15:00.000Z", expiresAt: "2026-11-13T11:00:00.000Z",
      queuedWakes: 4, runningRuns: 2, parkedRuns: 0,
    };
    const status = buildStapleConsoleUpgradeStatus(input([
      log("upgrade-20261113-0330.log", [...start, "[2026-11-13 03:30:08] running or settling work: 2 (queued work is held)"], "2026-11-13T10:30:08.000Z"),
    ], { now: "2026-11-13T10:31:00.000Z", hold }));
    expect(status.phase).toBe("running");
    expect(status.stage).toBe("draining");
    expect(status.drainRunning).toBe(2);
    expect(status.hold).toEqual(hold);
    expect(status.stages.map((cell) => cell.state)).toEqual(["done", "current", "pending", "pending", "pending", "pending"]);
    expect(status.nextAction).toMatch(/Parks still-running work/);
  });

  it("never invents download size, percent or ETA", () => {
    const status = buildStapleConsoleUpgradeStatus(input([
      log("upgrade-20261113-0330.log", [...installing, "Cloning into '/tmp/x'...", "Progress: resolved 812, reused 790"], "2026-11-13T10:39:00.000Z"),
    ]));
    expect(status.phase).toBe("running");
    expect(status.stage).toBe("download_build");
    expect(status.download).toEqual({ bytes: null, totalBytes: null });
    expect(status.stageStartedAt).toBe("2026-11-13T10:31:41.000Z");
    // The install's own output is progress: freshness follows the file, not the last timestamp.
    expect(status.lastOutputAt).toBe("2026-11-13T10:39:00.000Z");
    expect(JSON.stringify(status)).not.toMatch(/Cloning|Progress: resolved|backups\//);
  });

  it("marks a slow build stale only after 20 minutes without output", () => {
    const logs = [log("upgrade-20261113-0330.log", installing, "2026-11-13T10:31:41.000Z")];
    expect(buildStapleConsoleUpgradeStatus(input(logs, { now: "2026-11-13T10:50:00.000Z" })).phase).toBe("running");
    const stale = buildStapleConsoleUpgradeStatus(input(logs, { now: "2026-11-13T10:53:00.000Z" }));
    expect(stale.phase).toBe("stale");
    expect(stale.headline).toBe("Upgrade to 92585ac2 not reporting");
    expect(stale.stage).toBe("download_build");
  });

  it("moves to verify once Staple has restarted after the install began", () => {
    const status = buildStapleConsoleUpgradeStatus(input([
      log("upgrade-20261113-0330.log", [...installing, "Installed paperclipai git payload 92585ac285dc."], "2026-11-13T10:42:00.000Z"),
    ], { now: "2026-11-13T10:43:40.000Z", serverStartedAt: "2026-11-13T10:43:30.000Z", installedBuild: "92585ac" }));
    expect(status.stage).toBe("verify");
    expect(status.stageStartedAt).toBe("2026-11-13T10:43:30.000Z");
    expect(status.stages.find((cell) => cell.key === "restart")?.state).toBe("done");
  });

  it("is at restart once the payload is built and Staple has not come back", () => {
    const status = buildStapleConsoleUpgradeStatus(input([
      log("upgrade-20261113-0330.log", [...installing, "Installed paperclipai git payload 92585ac285dc."], "2026-11-13T10:42:00.000Z"),
    ], { now: "2026-11-13T10:42:10.000Z" }));
    expect(status.stage).toBe("restart");
    expect(status.stageStartedAt).toBeNull();
  });

  it("shows a busy wait from the quiet window as waiting, not failure", () => {
    const status = buildStapleConsoleUpgradeStatus(input([
      log("quiet-window.log", [
        "[2026-11-12 16:30:49] == Staple nightly upgrade (dry=0 quiet=1)",
        `[2026-11-12 16:30:50] installed=${INSTALLED} master=${TARGET}`,
        `[2026-11-12 16:30:51] certified target: target:${TARGET} installed-in-chain:yes`,
        "[2026-11-12 16:30:52] CI on target: green",
        "[2026-11-12 16:30:52] quiet-mode check 1: running=0",
        "[2026-11-12 16:31:52] quiet-mode check 2: running=1",
        "[2026-11-12 16:31:52] quiet-mode: busy, not installing now",
      ], "2026-11-12T23:31:52.000Z"),
    ], { now: "2026-11-12T23:40:00.000Z" }));
    expect(status.phase).toBe("waiting");
    expect(status.quiet).toBe(true);
    expect(status.headline).toBe("Waiting · Busy: work is running");
    expect(status.nextAction).toMatch(/^Retries at the next hourly check/);
    expect(status.stages.find((cell) => cell.key === "draining")?.state).toBe("skipped");
  });

  it("shows a CI wait as waiting with a watcher retry", () => {
    const status = buildStapleConsoleUpgradeStatus(input([
      log("upgrade-20261113-0330.log", [
        ...start.slice(0, 3),
        "[2026-11-13 03:30:07] CI on target: pending:Build",
        "[2026-11-13 03:30:07] pending, retry: master 92585ac2 CI still running (Build)",
        "[2026-11-13 03:30:07] REPORT: Waiting: master 92585ac2 CI still running (Build)",
      ], "2026-11-13T10:30:07.000Z"),
    ]));
    expect(status.phase).toBe("waiting");
    expect(status.headline).toBe("Waiting · master 92585ac2 CI still running (Build)");
    expect(status.stages).toEqual([]);
    expect(status.nextAction).toBe("Retries at the next watcher check");
  });

  it("shows a rollback with the failed verify stage and the build it returned to", () => {
    const status = buildStapleConsoleUpgradeStatus(input([
      log("upgrade-20261113-0330.log", [
        ...installing,
        "[2026-11-13 03:47:00] verify: health commit 69187fe6a1b2c3d4e5f60718293a4b5c6d7e8f90, startup not-checked",
        "[2026-11-13 03:47:00] upgrade failed verification; rolling back",
        "[2026-11-13 03:48:30] maintenance hold released (rolled back to 69187fe6): HTTP 200 wasActive=True queued=4",
        "[2026-11-13 03:48:31] REPORT: Rolled back: 92585ac2 failed checks, back on 69187fe6",
      ], "2026-11-13T10:48:31.000Z"),
    ]));
    expect(status.phase).toBe("rolled_back");
    expect(status.headline).toBe("Rolled back · back on 69187fe6");
    expect(status.stages.find((cell) => cell.key === "verify")?.state).toBe("failed");
    expect(status.needsEthan).toBeNull();
  });

  it("shows a rollback in progress", () => {
    const status = buildStapleConsoleUpgradeStatus(input([
      log("upgrade-20261113-0330.log", [
        ...installing,
        "[2026-11-13 03:47:00] verify: health commit unreadable, startup not-checked",
        "[2026-11-13 03:47:00] upgrade failed verification; rolling back",
      ], "2026-11-13T10:47:00.000Z"),
    ], { now: "2026-11-13T10:48:00.000Z" }));
    expect(status.phase).toBe("running");
    expect(status.stage).toBe("rollback");
    expect(status.stageStartedAt).toBe("2026-11-13T10:47:00.000Z");
    expect(status.stages.find((cell) => cell.key === "verify")?.state).toBe("failed");
    expect(status.nextAction).toBe("Restores 69187fe6, then releases held work");
  });

  it("asks Ethan only when upgrade and rollback both failed", () => {
    const status = buildStapleConsoleUpgradeStatus(input([
      log("upgrade-20261113-0330.log", [
        ...installing,
        "[2026-11-13 03:47:00] verify: health commit unreadable, startup not-checked",
        "[2026-11-13 03:47:00] upgrade failed verification; rolling back",
        "[2026-11-13 03:52:00] REPORT: NEEDS ETHAN: upgrade and rollback both failed",
      ], "2026-11-13T10:52:00.000Z"),
    ]));
    expect(status.phase).toBe("needs_ethan");
    expect(status.needsEthan).toMatch(/restore the pre-upgrade backup/);
    expect(status.nextAction).toBeNull();
  });

  it("treats a failed backup as a failure that left the build unchanged", () => {
    const status = buildStapleConsoleUpgradeStatus(input([
      log("upgrade-20261113-0330.log", [
        ...drained,
        "[2026-11-13 03:31:40] backup: error:backup file empty (/home/paperclip/x.sql.gz)",
        "[2026-11-13 03:31:40] REPORT: Skipped: database backup failed (backup file empty (/home/paperclip/x.sql.gz))",
      ], "2026-11-13T10:31:40.000Z"),
    ]));
    expect(status.phase).toBe("failed");
    expect(status.headline).toBe("Upgrade to 92585ac2 failed · still on 69187fe6");
    expect(status.stages.find((cell) => cell.key === "backup")?.state).toBe("failed");
    expect(status.stages.find((cell) => cell.key === "download_build")?.state).toBe("skipped");
  });

  it("keeps the last install visible behind a later up-to-date check", () => {
    const status = buildStapleConsoleUpgradeStatus(input([
      log("upgrade-20261113-0330.log", [
        ...installing,
        "[2026-11-13 03:44:10] verify: health commit 92585ac285dcea110b7f6f5310eea17842b850b9, startup logged",
        "[2026-11-13 03:44:13] REPORT: Upgraded Staple 69187fe6 -> 92585ac2",
      ], "2026-11-13T10:44:13.000Z"),
      log("quiet-window.log", [
        "[2026-11-13 04:30:00] == Staple nightly upgrade (dry=0 quiet=1)",
        `[2026-11-13 04:30:01] installed=${TARGET} master=${TARGET}`,
        "[2026-11-13 04:30:01] Already on master. Nothing to do.",
        "[2026-11-13 05:30:00] == Staple nightly upgrade (dry=1 quiet=1)",
      ], "2026-11-13T12:30:00.000Z"),
    ], { now: "2026-11-13T12:31:00.000Z", installedBuild: "92585ac" }));
    expect(status.phase).toBe("up_to_date");
    expect(status.lastInstall).toEqual({ phase: "verified", at: "2026-11-13T10:44:13.000Z", from: "69187fe6", to: "92585ac2" });
  });

  it("shows the 02:30 hold as the window draining before the upgrade", () => {
    const status = buildStapleConsoleUpgradeStatus(input([
      log("hold-20261113-0230.log", [
        "[2026-11-13 02:30:00] == Staple maintenance hold (drain 45 min, max 90 min)",
        `[2026-11-13 02:30:02] certified target: target:${TARGET} installed-in-chain:yes`,
        "[2026-11-13 02:30:03] maintenance hold active since 2026-11-13T09:30:03.000Z; park at 2026-11-13T10:15:03.000Z; auto-release by 2026-11-13T11:00:03.000Z; queued=0 running=3",
      ], "2026-11-13T09:30:03.000Z"),
    ], {
      now: "2026-11-13T09:40:00.000Z",
      hold: { since: "2026-11-13T09:30:03.000Z", drainDeadlineAt: "2026-11-13T10:15:03.000Z", expiresAt: "2026-11-13T11:00:03.000Z", queuedWakes: 2, runningRuns: 3, parkedRuns: 0 },
    }));
    expect(status.phase).toBe("running");
    expect(status.stage).toBe("draining");
    expect(status.target).toBe("92585ac2");
    expect(status.drainRunning).toBe(3);
    expect(status.nextAction).toMatch(/upgrade starts at 03:30/);
  });

  it("says unknown when the installer log cannot be read", () => {
    const status = buildStapleConsoleUpgradeStatus(input(null));
    expect(status.phase).toBe("unknown");
    expect(status.source).toEqual({ available: false, detail: "installer log not readable", logName: null });
  });

  it("marks an attempt stale when the installer stopped writing mid-drain", () => {
    const status = buildStapleConsoleUpgradeStatus(input([
      log("upgrade-20261113-0330.log", [...start, "[2026-11-13 03:30:08] running or settling work: 2 (queued work is held)"], "2026-11-13T10:30:08.000Z"),
    ], { now: "2026-11-13T10:45:00.000Z" }));
    expect(status.phase).toBe("stale");
    expect(status.nextAction).toBe("Next try: the 03:30 nightly attempt");
  });
});
