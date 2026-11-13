/**
 * Read-only access to the managed installer's log directory for the Staple Console upgrade card
 * (FAC-620 upgrade status). `staple-nightly-upgrade` writes `~/.paperclip/nightly/` as the same
 * user the service runs as, so the files are there again after the install restart.
 *
 * Only the newest few logs are read, and each one at most HEAD_BYTES + TAIL_BYTES: the head keeps
 * an attempt's start (target, CI, hold), the tail its latest step. Nothing here writes, and no line
 * leaves the server: `buildStapleConsoleUpgradeStatus` reduces them to stages and times.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StapleUpgradeLogFile } from "@paperclipai/shared/staple-console";

const HEAD_BYTES = 16 * 1024;
const TAIL_BYTES = 256 * 1024;
const UPGRADE_LOGS = 2;

export function stapleUpgradeLogDir(env: NodeJS.ProcessEnv = process.env) {
  return env.STAPLE_NIGHTLY_LOG_DIR?.trim() || path.join(os.homedir(), ".paperclip", "nightly");
}

/** The zone of the installer's `date '+%F %T'` timestamps: the host's, unless stated. */
export function stapleUpgradeLogTimeZone(env: NodeJS.ProcessEnv = process.env) {
  return env.STAPLE_NIGHTLY_LOG_TZ?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

async function readBounded(file: string): Promise<{ text: string; modifiedAt: string } | null> {
  let handle: fs.FileHandle | null = null;
  try {
    // A log is a regular file the installer wrote; never follow a link out of the directory.
    if (!(await fs.lstat(file)).isFile()) return null;
    handle = await fs.open(file, "r");
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    const modifiedAt = stat.mtime.toISOString();
    if (stat.size <= HEAD_BYTES + TAIL_BYTES) {
      const buffer = Buffer.alloc(stat.size);
      await handle.read(buffer, 0, stat.size, 0);
      return { text: buffer.toString("utf8"), modifiedAt };
    }
    const head = Buffer.alloc(HEAD_BYTES);
    const tail = Buffer.alloc(TAIL_BYTES);
    await handle.read(head, 0, HEAD_BYTES, 0);
    await handle.read(tail, 0, TAIL_BYTES, stat.size - TAIL_BYTES);
    // Drop the partial lines at both cuts.
    const headText = head.toString("utf8");
    const tailText = tail.toString("utf8");
    return {
      text: `${headText.slice(0, headText.lastIndexOf("\n") + 1)}${tailText.slice(tailText.indexOf("\n") + 1)}`,
      modifiedAt,
    };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * The newest upgrade logs, the newest 02:30 hold log and the quiet-window log. Null when the
 * directory exists but cannot be read; empty when the installer has never run on this host.
 */
export async function readStapleUpgradeLogs(dir = stapleUpgradeLogDir()): Promise<StapleUpgradeLogFile[] | null> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? [] : null;
  }
  // File names carry `date +%Y%m%d-%H%M`, so name order is time order.
  const newest = (pattern: RegExp, count: number) => names.filter((name) => pattern.test(name)).sort().slice(-count);
  const picked = [
    ...newest(/^upgrade-\d{8}-\d{4}\.log$/, UPGRADE_LOGS),
    ...newest(/^hold-\d{8}-\d{4}\.log$/, 1),
    ...names.filter((name) => name === "quiet-window.log"),
  ];
  const files: StapleUpgradeLogFile[] = [];
  for (const name of picked) {
    const read = await readBounded(path.join(dir, name));
    if (read) files.push({ name, ...read });
  }
  return files;
}
