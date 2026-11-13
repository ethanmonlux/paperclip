/**
 * Read-only access to the managed installer's log directory for the Staple Console upgrade card
 * (FAC-620 upgrade status). `staple-nightly-upgrade` writes `~/.paperclip/nightly/` as the same
 * user the service runs as, so the files are there again after the install restart.
 *
 * Only the newest few logs are read, each one at most HEAD_BYTES + TAIL_BYTES: the tail keeps the
 * latest step, and the head is the start (target, CI, hold) of the attempt that tail belongs to.
 * `quiet-window.log` is appended to every hour, so that start is found by scanning back from the
 * tail, never assumed to be the file's first line. If it is more than SCAN_BYTES back, the file is
 * marked `startUnread` and the Console says the attempt is unknown. Nothing here writes, and no
 * line leaves the server: `buildStapleConsoleUpgradeStatus` reduces them to stages and times.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StapleUpgradeLogFile } from "@paperclipai/shared/staple-console";

const HEAD_BYTES = 16 * 1024;
const TAIL_BYTES = 256 * 1024;
const SCAN_BYTES = 8 * 1024 * 1024;
const SCAN_CHUNK = 256 * 1024;
const START_MARK = Buffer.from("] == Staple ");
/** `[%F %T` before the mark. */
const STAMP_BYTES = 20;
const STAMP_RE = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const UPGRADE_LOGS = 2;

export function stapleUpgradeLogDir(env: NodeJS.ProcessEnv = process.env) {
  return env.STAPLE_NIGHTLY_LOG_DIR?.trim() || path.join(os.homedir(), ".paperclip", "nightly");
}

/** The zone of the installer's `date '+%F %T'` timestamps: the host's, unless stated. */
export function stapleUpgradeLogTimeZone(env: NodeJS.ProcessEnv = process.env) {
  return env.STAPLE_NIGHTLY_LOG_TZ?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

async function readAt(handle: fs.FileHandle, start: number, end: number) {
  const buffer = Buffer.alloc(Math.max(0, end - start));
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
  return buffer.subarray(0, bytesRead);
}

/** Offset of the last attempt start line (`[%F %T] == Staple …`) that begins before `before`, scanning back at most SCAN_BYTES. */
async function lastAttemptStart(handle: fs.FileHandle, before: number): Promise<number | "unread" | null> {
  const floor = Math.max(0, before - SCAN_BYTES);
  let end = before;
  while (end > floor) {
    const start = Math.max(floor, end - SCAN_CHUNK);
    // One byte early for the newline before a line, and past `end` so a start line cut by the
    // chunk edge is still whole.
    const base = Math.max(0, start - 1);
    const chunk = await readAt(handle, base, end + STAMP_BYTES + START_MARK.length);
    let at = chunk.lastIndexOf(START_MARK);
    while (at >= 0) {
      const lineStart = at - STAMP_BYTES;
      const offset = base + lineStart;
      if (lineStart >= 0 && offset >= start && offset < end
        && STAMP_RE.test(chunk.subarray(lineStart, at).toString("latin1"))
        && (offset === 0 || (lineStart > 0 && chunk[lineStart - 1] === 0x0a))) {
        return offset;
      }
      at = at > 0 ? chunk.lastIndexOf(START_MARK, at - 1) : -1;
    }
    end = start;
  }
  return floor > 0 ? "unread" : null;
}

async function readBounded(file: string): Promise<Omit<StapleUpgradeLogFile, "name"> | null> {
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
    const tailStart = stat.size - TAIL_BYTES;
    // From one byte early, so a line that begins exactly at the cut is kept whole.
    const tailRaw = (await readAt(handle, tailStart - 1, stat.size)).toString("utf8");
    const tailText = tailRaw.slice(tailRaw.indexOf("\n") + 1);
    const owner = await lastAttemptStart(handle, tailStart);
    if (owner === null || owner === "unread") {
      // No attempt starts before the tail, or its start is too far back to read.
      return { text: tailText, modifiedAt, ...(owner === "unread" ? { startUnread: true } : {}) };
    }
    if (owner + HEAD_BYTES >= tailStart) {
      return { text: (await readAt(handle, owner, stat.size)).toString("utf8"), modifiedAt };
    }
    // The owning attempt's start, cut at a line end, then the tail; the build output between is dropped.
    const headText = (await readAt(handle, owner, owner + HEAD_BYTES)).toString("utf8");
    return { text: `${headText.slice(0, headText.lastIndexOf("\n") + 1)}${tailText}`, modifiedAt };
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
