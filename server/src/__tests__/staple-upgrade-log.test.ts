import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildStapleConsoleUpgradeStatus } from "@paperclipai/shared/staple-console";
import { readStapleUpgradeLogs, stapleUpgradeLogDir } from "../services/staple-upgrade-log.js";

const dirs: string[] = [];
async function tempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "staple-upgrade-log-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("readStapleUpgradeLogs", () => {
  it("reads the newest two upgrade logs, the newest hold log and the quiet-window log", async () => {
    const dir = await tempDir();
    for (const name of [
      "upgrade-20261111-0330.log", "upgrade-20261112-1647.log", "upgrade-20261113-0330.log",
      "hold-20261112-0230.log", "hold-20261113-0230.log", "quiet-window.log", "certify-reported", "report-issue-id",
    ]) await writeFile(path.join(dir, name), `${name}\n`);
    const logs = await readStapleUpgradeLogs(dir);
    expect(logs?.map((file) => file.name)).toEqual([
      "upgrade-20261112-1647.log", "upgrade-20261113-0330.log", "hold-20261113-0230.log", "quiet-window.log",
    ]);
    expect(logs?.[0]?.text).toBe("upgrade-20261112-1647.log\n");
    expect(Number.isFinite(Date.parse(logs![0]!.modifiedAt))).toBe(true);
  });

  it("keeps an attempt's start and its latest step from a long log, dropping cut lines", async () => {
    const dir = await tempDir();
    const filler = Array.from({ length: 40_000 }, (_, index) => `build output line ${index}`).join("\n");
    await writeFile(
      path.join(dir, "upgrade-20261113-0330.log"),
      `[2026-11-13 03:30:01] == Staple nightly upgrade (dry=0 quiet=0)\n${filler}\n[2026-11-13 03:50:00] verify: health commit abc, startup logged\n`,
    );
    const [file] = (await readStapleUpgradeLogs(dir))!;
    expect(file!.text.startsWith("[2026-11-13 03:30:01] == Staple nightly upgrade")).toBe(true);
    expect(file!.text.endsWith("[2026-11-13 03:50:00] verify: health commit abc, startup logged\n")).toBe(true);
    expect(file!.text.length).toBeLessThan(280 * 1024);
    for (const line of file!.text.trimEnd().split("\n")) expect(line).toMatch(/^(\[2026|build output line \d+$)/);
  });

  it("ties a long appended log's tail to the attempt it belongs to, not the file's first one (FAC-945)", async () => {
    const dir = await tempDir();
    const sha = "b".repeat(40);
    const old = [
      "[2026-11-12 03:30:01] == Staple nightly upgrade (dry=0 quiet=1)",
      `[2026-11-12 03:30:03] installed=${"a".repeat(40)} master=${"a".repeat(40)}`,
      "[2026-11-12 03:30:04] Already on master. Nothing to do.",
    ].join("\n");
    const current = [
      "[2026-11-13 03:30:01] == Staple nightly upgrade (dry=0 quiet=1)",
      `[2026-11-13 03:30:03] installed=${"a".repeat(40)} master=${sha}`,
      `[2026-11-13 03:30:05] certified target: target:${sha} installed-in-chain:yes`,
      "[2026-11-13 03:31:00] running or settling work: 0 (queued work is held)",
      "[2026-11-13 03:31:40] backup: file:/private/backup.sql.gz",
      "[2026-11-13 03:31:41] installing bbbbbbbb",
    ].join("\n");
    await writeFile(
      path.join(dir, "quiet-window.log"),
      `${old}\n${"old output\n".repeat(2000)}${current}\n${"build output\n".repeat(30_000)}`,
    );
    const logs = (await readStapleUpgradeLogs(dir))!;
    expect(logs[0]!.text).not.toContain("Already on master");
    expect(logs[0]!.text.startsWith("[2026-11-13 03:30:01] == Staple nightly upgrade")).toBe(true);
    expect(logs[0]!.startUnread).toBeUndefined();
    const status = buildStapleConsoleUpgradeStatus({
      now: new Date(Date.parse(logs[0]!.modifiedAt) + 60_000).toISOString(),
      timeZone: "America/Denver",
      logs: logs.map((file) => ({ ...file, modifiedAt: "2026-11-13T10:40:00.000Z" })),
      hold: null,
      installedBuild: "aaaaaaaa",
      serverStartedAt: null,
      nextNightlyAt: null,
    });
    expect(status.stage).toBe("download_build");
    expect(status.target).toBe("bbbbbbbb");
  });

  it("marks a log whose current attempt starts too far back as start-unread", async () => {
    const dir = await tempDir();
    const head = "[2026-11-13 03:30:01] == Staple nightly upgrade (dry=0 quiet=1)\n";
    await writeFile(path.join(dir, "quiet-window.log"), `${head}${"build output line\n".repeat(560_000)}`);
    const [file] = (await readStapleUpgradeLogs(dir))!;
    expect(file!.startUnread).toBe(true);
    expect(file!.text).not.toContain("== Staple");
    expect(file!.text.length).toBeLessThanOrEqual(256 * 1024);
  });

  it("is empty when the installer never ran, and never follows a link out of the directory", async () => {
    const dir = await tempDir();
    expect(await readStapleUpgradeLogs(path.join(dir, "missing"))).toEqual([]);
    const outside = path.join(dir, "outside.txt");
    await writeFile(outside, "secret\n");
    const logDir = path.join(dir, "nightly");
    await mkdir(logDir);
    await symlink(outside, path.join(logDir, "quiet-window.log"));
    expect(await readStapleUpgradeLogs(logDir)).toEqual([]);
  });

  it("defaults to ~/.paperclip/nightly and honours an explicit directory", () => {
    expect(stapleUpgradeLogDir({})).toBe(path.join(os.homedir(), ".paperclip", "nightly"));
    expect(stapleUpgradeLogDir({ STAPLE_NIGHTLY_LOG_DIR: "/srv/nightly" })).toBe("/srv/nightly");
  });
});
