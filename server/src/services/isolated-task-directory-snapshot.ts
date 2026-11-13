import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_RESTORE_POINT_LIMITS } from "./git-restore-point.js";

export const TASK_DIRECTORY_RETENTION_KEY = "isolatedTaskDirectoryRetention";
export const TASK_DIRECTORY_SNAPSHOT_SCHEMA = "paperclip.task-directory-snapshot.v1";
const PAYLOAD_MAGIC = Buffer.from("PCTD-PLAIN1\n");
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;

export type TaskDirectorySnapshotLimits = { maxFiles: number; maxFileBytes: number; maxTotalBytes: number };

export const DEFAULT_TASK_DIRECTORY_SNAPSHOT_LIMITS: TaskDirectorySnapshotLimits = {
  maxFiles: DEFAULT_RESTORE_POINT_LIMITS.maxFiles,
  maxFileBytes: DEFAULT_RESTORE_POINT_LIMITS.maxFileBytes,
  maxTotalBytes: DEFAULT_RESTORE_POINT_LIMITS.maxTotalBytes,
};

export type TaskDirectoryEntry =
  | { path: string; type: "directory"; mode: number }
  | { path: string; type: "file"; mode: number; size: number; sha256: string }
  | { path: string; type: "symlink"; target: string };

export type TaskDirectorySnapshotManifest = {
  schema: typeof TASK_DIRECTORY_SNAPSHOT_SCHEMA;
  entries: TaskDirectoryEntry[];
  excluded: string[];
};

export class TaskDirectorySnapshotSkip extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "TaskDirectorySnapshotSkip";
  }
}

export class TaskDirectoryRestoreFailure extends Error {
  constructor(readonly reason: string) {
    super(`The task directory could not be restored: ${reason}`);
    this.name = "TaskDirectoryRestoreFailure";
  }
}

const bySortKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

type WalkOptions = {
  limits: TaskDirectorySnapshotLimits;
  signal?: AbortSignal;
  nestedGit: "reject" | "allow" | "collect";
  readFile: (absolute: string, relative: string, size: number) => Promise<string>;
};

async function walk(root: string, options: WalkOptions) {
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new TaskDirectorySnapshotSkip("unsafe_task_directory");
  const entries: TaskDirectoryEntry[] = [];
  const excluded: string[] = [];
  const repositories: string[] = [];
  let files = 0;
  let total = 0;
  let newestMtimeMs = rootStat.mtimeMs;
  const visit = async (relativeDir: string) => {
    options.signal?.throwIfAborted();
    const absoluteDir = relativeDir ? path.join(root, relativeDir) : root;
    const names = (await fs.readdir(absoluteDir)).sort(bySortKey);
    // A task directory can contain a checkout at repo/. A directory snapshot
    // does not establish that checkout's HEAD or publication state, and its
    // generated contents can exceed the restore-point limits. Leave the whole
    // task directory intact until repository delivery is qualified separately.
    // A code-delivery preview instead records each nested checkout and leaves
    // its contents to a separate repository proof; the root itself never
    // qualifies as a nested checkout.
    if (names.includes(".git") && options.nestedGit !== "allow") {
      if (options.nestedGit === "reject" || !relativeDir) throw new TaskDirectorySnapshotSkip("nested_git_repository");
      repositories.push(relativeDir);
      return;
    }
    const hasPackageManifest = names.includes("package.json")
      && (await fs.lstat(path.join(absoluteDir, "package.json"))).isFile();
    for (const name of names) {
      options.signal?.throwIfAborted();
      const relative = relativeDir ? `${relativeDir}/${name}` : name;
      const absolute = path.join(absoluteDir, name);
      const stat = await fs.lstat(absolute);
      newestMtimeMs = Math.max(newestMtimeMs, stat.mtimeMs);
      if (stat.isSymbolicLink()) {
        entries.push({ path: relative, type: "symlink", target: await fs.readlink(absolute) });
        continue;
      }
      if (stat.isDirectory()) {
        if (name === "node_modules" && hasPackageManifest) {
          excluded.push(relative);
          continue;
        }
        entries.push({ path: relative, type: "directory", mode: stat.mode & 0o777 });
        await visit(relative);
        continue;
      }
      if (!stat.isFile()) throw new TaskDirectorySnapshotSkip("unsupported_filesystem_entry");
      files += 1;
      total += stat.size;
      if (files > options.limits.maxFiles) throw new TaskDirectorySnapshotSkip("task_directory_too_many_files");
      if (stat.size > options.limits.maxFileBytes) throw new TaskDirectorySnapshotSkip("task_directory_file_too_large");
      if (total > options.limits.maxTotalBytes) throw new TaskDirectorySnapshotSkip("task_directory_too_large");
      entries.push({ path: relative, type: "file", mode: stat.mode & 0o777, size: stat.size,
        sha256: await options.readFile(absolute, relative, stat.size) });
    }
  };
  await visit("");
  return { entries, excluded, repositories, newestMtimeMs };
}

export function taskDirectoryManifestDigest(manifest: Pick<TaskDirectorySnapshotManifest, "entries">) {
  return createHash("sha256").update(JSON.stringify([TASK_DIRECTORY_SNAPSHOT_SCHEMA, manifest.entries])).digest("hex");
}

async function hashFile(absolute: string, size: number) {
  const handle = await fs.open(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const hash = createHash("sha256");
    let read = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      read += (chunk as Buffer).length;
      hash.update(chunk as Buffer);
    }
    if (read !== size) throw new TaskDirectorySnapshotSkip("task_directory_changed");
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

export async function inspectTaskDirectory(root: string, options: { limits?: TaskDirectorySnapshotLimits; signal?: AbortSignal;
  restoreVerification?: boolean; nestedRepositories?: boolean } = {}) {
  const walked = await walk(root, { limits: options.limits ?? DEFAULT_TASK_DIRECTORY_SNAPSHOT_LIMITS, signal: options.signal,
    nestedGit: options.restoreVerification ? "allow" : options.nestedRepositories ? "collect" : "reject",
    readFile: (absolute, _relative, size) => hashFile(absolute, size) });
  return { digest: taskDirectoryManifestDigest(walked), entries: walked.entries.length, excluded: walked.excluded.length,
    repositories: walked.repositories,
    newestMtimeMs: walked.newestMtimeMs };
}

export async function newestTaskDirectoryMtime(root: string, signal?: AbortSignal): Promise<number> {
  const stat = await fs.lstat(root);
  let newest = stat.mtimeMs;
  if (!stat.isDirectory() || stat.isSymbolicLink()) return newest;
  for (const name of await fs.readdir(root)) {
    signal?.throwIfAborted();
    newest = Math.max(newest, await newestTaskDirectoryMtime(path.join(root, name), signal));
  }
  return newest;
}

/** With `nestedRepositories`, each nested checkout is saved as an empty
 * directory and listed in `repositories`; its recipe rebuilds the contents. */
export async function captureTaskDirectorySnapshot(root: string, options: { limits?: TaskDirectorySnapshotLimits; signal?: AbortSignal;
  nestedRepositories?: boolean } = {}) {
  const bodies: Buffer[] = [];
  const walked = await walk(root, { limits: options.limits ?? DEFAULT_TASK_DIRECTORY_SNAPSHOT_LIMITS, signal: options.signal,
    nestedGit: options.nestedRepositories ? "collect" : "reject",
    readFile: async (absolute, _relative, size) => {
      const handle = await fs.open(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const body = await handle.readFile();
        if (body.length !== size) throw new TaskDirectorySnapshotSkip("task_directory_changed");
        bodies.push(body);
        return createHash("sha256").update(body).digest("hex");
      } finally {
        await handle.close();
      }
    } });
  return { ...encodeTaskDirectorySnapshot({ schema: TASK_DIRECTORY_SNAPSHOT_SCHEMA, entries: walked.entries, excluded: walked.excluded }, bodies),
    repositories: walked.repositories };
}

export function createEmptyTaskDirectorySnapshot() {
  return encodeTaskDirectorySnapshot({ schema: TASK_DIRECTORY_SNAPSHOT_SCHEMA, entries: [], excluded: [] }, []);
}

function encodeTaskDirectorySnapshot(manifest: TaskDirectorySnapshotManifest, bodies: Buffer[]) {
  const encoded = Buffer.from(JSON.stringify(manifest));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(encoded.length);
  const payload = Buffer.concat([PAYLOAD_MAGIC, length, encoded, ...bodies]);
  try { decodeTaskDirectorySnapshot(payload); }
  catch { throw new TaskDirectorySnapshotSkip("task_directory_not_restorable"); }
  return {
    payload,
    digest: taskDirectoryManifestDigest(manifest),
    files: manifest.entries.filter(entry => entry.type === "file").length,
    excluded: manifest.excluded.length,
  };
}

function validRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value.includes("\0")) return false;
  if (path.sep !== "/" && value.includes(path.sep)) return false;
  if (value.startsWith("/")) return false;
  return value.split("/").every(part => part.length > 0 && part !== "." && part !== "..");
}

export function decodeTaskDirectorySnapshot(payload: Buffer): { manifest: TaskDirectorySnapshotManifest; bodies: Buffer } {
  if (payload.length < PAYLOAD_MAGIC.length + 4 || !payload.subarray(0, PAYLOAD_MAGIC.length).equals(PAYLOAD_MAGIC)) {
    throw new TaskDirectoryRestoreFailure("invalid_snapshot_payload");
  }
  const length = payload.readUInt32BE(PAYLOAD_MAGIC.length);
  const start = PAYLOAD_MAGIC.length + 4;
  if (length > MAX_MANIFEST_BYTES || start + length > payload.length) throw new TaskDirectoryRestoreFailure("invalid_snapshot_payload");
  let manifest: TaskDirectorySnapshotManifest;
  try { manifest = JSON.parse(payload.subarray(start, start + length).toString("utf8")); }
  catch { throw new TaskDirectoryRestoreFailure("invalid_snapshot_payload"); }
  if (!manifest || manifest.schema !== TASK_DIRECTORY_SNAPSHOT_SCHEMA || !Array.isArray(manifest.entries) || !Array.isArray(manifest.excluded)) {
    throw new TaskDirectoryRestoreFailure("invalid_snapshot_payload");
  }
  const kinds = new Map<string, TaskDirectoryEntry["type"]>();
  let bodyBytes = 0;
  for (const entry of manifest.entries) {
    if (!entry || !validRelativePath(entry.path) || kinds.has(entry.path)) throw new TaskDirectoryRestoreFailure("invalid_snapshot_entry");
    const parent = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : null;
    if (parent !== null && kinds.get(parent) !== "directory") throw new TaskDirectoryRestoreFailure("invalid_snapshot_entry");
    if (entry.type === "file") {
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[0-9a-f]{64}$/.test(entry.sha256)
        || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) throw new TaskDirectoryRestoreFailure("invalid_snapshot_entry");
      bodyBytes += entry.size;
    } else if (entry.type === "directory") {
      if (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) throw new TaskDirectoryRestoreFailure("invalid_snapshot_entry");
    } else if (entry.type !== "symlink" || typeof entry.target !== "string" || entry.target.length === 0 || entry.target.includes("\0")) {
      throw new TaskDirectoryRestoreFailure("invalid_snapshot_entry");
    }
    kinds.set(entry.path, entry.type);
  }
  if (manifest.excluded.some(value => !validRelativePath(value))) throw new TaskDirectoryRestoreFailure("invalid_snapshot_entry");
  const bodies = payload.subarray(start + length);
  if (bodies.length !== bodyBytes) throw new TaskDirectoryRestoreFailure("invalid_snapshot_payload");
  return { manifest, bodies };
}

export function shortSiblingName(target: string, prefix: string) {
  const length = Math.max(8, path.basename(target).length - prefix.length);
  return path.join(path.dirname(target), `${prefix}${randomBytes(Math.ceil(length / 2)).toString("hex").slice(0, length)}`);
}

export async function materializeTaskDirectorySnapshot(input: { payload: Buffer; target: string; expectedDigest: string; signal?: AbortSignal }) {
  const { manifest, bodies } = decodeTaskDirectorySnapshot(input.payload);
  if (taskDirectoryManifestDigest(manifest) !== input.expectedDigest) throw new TaskDirectoryRestoreFailure("snapshot_digest_mismatch");
  const staging = shortSiblingName(input.target, ".restoring-");
  await fs.mkdir(staging, { mode: 0o700 });
  try {
    let offset = 0;
    const directories: Array<{ target: string; mode: number }> = [];
    for (const entry of manifest.entries) {
      input.signal?.throwIfAborted();
      const target = path.join(staging, ...entry.path.split("/"));
      if (entry.type === "directory") {
        await fs.mkdir(target, { mode: 0o700 });
        directories.push({ target, mode: entry.mode });
      } else if (entry.type === "symlink") {
        await fs.symlink(entry.target, target);
      } else {
        const body = bodies.subarray(offset, offset + entry.size);
        offset += entry.size;
        if (createHash("sha256").update(body).digest("hex") !== entry.sha256) throw new TaskDirectoryRestoreFailure("snapshot_content_mismatch");
        const handle = await fs.open(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        try { await handle.writeFile(body); } finally { await handle.close(); }
        await fs.chmod(target, entry.mode);
      }
    }
    for (const directory of directories.reverse()) await fs.chmod(directory.target, directory.mode);
    const restored = await inspectTaskDirectory(staging, { limits: { maxFiles: Number.MAX_SAFE_INTEGER, maxFileBytes: Number.MAX_SAFE_INTEGER,
      maxTotalBytes: Number.MAX_SAFE_INTEGER }, signal: input.signal, restoreVerification: true });
    if (restored.digest !== input.expectedDigest) throw new TaskDirectoryRestoreFailure("restored_contents_mismatch");
    return staging;
  } catch (error) {
    await removeTaskDirectoryTree(staging).catch(() => undefined);
    throw error;
  }
}

const MAX_WALK_ENTRIES = 200_000;

function missing<T>(fallback: T) {
  return (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return fallback;
    throw error;
  };
}

const REMOVAL_RECORD_SCHEMA = "paperclip.task-directory-removal.v1";

const identity = (stat: BigIntStats) => `${stat.dev}:${stat.ino}`;

/** A regenerable node_modules beside a package.json, which snapshots never
 * save and checks before removal ignore. */
async function regenerableDependencies(root: string, relativeDir: string, names: string[]) {
  if (!names.includes("node_modules") || !names.includes("package.json")) return false;
  return Boolean((await fs.lstat(path.join(root, relativeDir, "package.json")).catch(missing(null)))?.isFile());
}

/** Walk `root` in order until `visitEntry` returns false, skipping
 * dependencies: the regenerable ones, reported to `onSkip`, or only the
 * `recorded` ones, by path and inode. Returns false when it holds more than
 * `maxEntries` entries. */
async function walkTaskDirectory(root: string, visitEntry: (relative: string, stat: BigIntStats) => boolean,
  options: { signal?: AbortSignal; maxEntries?: number; recorded?: Map<string, string>; onSkip?: (relative: string, stat: BigIntStats) => void }) {
  const maxEntries = options.maxEntries ?? MAX_WALK_ENTRIES;
  let scanned = 0;
  let stopped = false;
  const visit = async (relativeDir: string): Promise<boolean> => {
    options.signal?.throwIfAborted();
    const names = (await fs.readdir(relativeDir ? path.join(root, relativeDir) : root).catch(missing<string[]>([]))).sort(bySortKey);
    const skipDependencies = !options.recorded && await regenerableDependencies(root, relativeDir, names);
    for (const name of names) {
      if (++scanned > maxEntries) return false;
      const relative = relativeDir ? `${relativeDir}/${name}` : name;
      const stat = await fs.lstat(path.join(root, relative), { bigint: true }).catch(missing(null));
      if (!stat) continue;
      if (name === "node_modules" && skipDependencies && stat.isDirectory()) {
        options.onSkip?.(relative, stat);
        continue;
      }
      if (stat.isDirectory() && options.recorded?.get(relative) === identity(stat)) continue;
      if (!visitEntry(relative, stat)) stopped = true;
      else if (stat.isDirectory() && !await visit(relative)) return false;
      if (stopped) return true;
    }
    return true;
  };
  return visit("");
}

/** Every directory in `root` by path and inode, taken before the check that
 * precedes removal. A restart compares what is left against it: a directory
 * moved in later keeps its old file times but not an inode from this list.
 * The regenerable dependencies skipped are listed too, also by inode, so a
 * restart still skips one whose package.json the removal already deleted but
 * never one made or moved in later. Null when the folder is too large to
 * record. */
export async function recordTaskDirectoryDirectories(root: string, options: { signal?: AbortSignal; maxEntries?: number } = {}) {
  const rootStat = await fs.lstat(root, { bigint: true });
  const directories: Array<[string, string]> = [["", identity(rootStat)]];
  const dependencies: Array<[string, string]> = [];
  const complete = await walkTaskDirectory(root, (relative, stat) => {
    if (stat.isDirectory()) directories.push([relative, identity(stat)]);
    return true;
  }, { ...options, onSkip: (relative, stat) => dependencies.push([relative, identity(stat)]) });
  return complete ? JSON.stringify({ schema: REMOVAL_RECORD_SCHEMA, directories, dependencies }) : null;
}

/** Durably write a removal record and return its digest. */
export async function writeTaskDirectoryRemovalRecord(file: string, record: string) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(record);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, file);
  const directory = await fs.open(path.dirname(file), "r");
  try { await directory.sync(); } finally { await directory.close(); }
  return createHash("sha256").update(record).digest("hex");
}

/** The removal record with this digest, or null when it is missing or differs. */
export async function readTaskDirectoryRemovalRecord(file: string, digest: string) {
  const record = await fs.readFile(file, "utf8").catch(missing(null));
  return record !== null && createHash("sha256").update(record).digest("hex") === digest ? record : null;
}

/** What is left of a partly removed folder holds nothing but what the removal
 * began with: every directory is one recorded before the check, at the same
 * path, and no file, symlink or other entry changed since `sinceMs`. Every
 * write, rename or link advances an entry's status-change time and no process
 * can set it back. Directory times are not compared, because removing their
 * entries advances them. */
export async function taskDirectoryRemainderUnchanged(root: string, sinceMs: number, record: string,
  options: { signal?: AbortSignal; maxEntries?: number } = {}) {
  const parsed = JSON.parse(record) as { schema?: string; directories?: Array<[string, string]>; dependencies?: Array<[string, string]> };
  if (parsed.schema !== REMOVAL_RECORD_SCHEMA || !Array.isArray(parsed.directories) || !Array.isArray(parsed.dependencies)) return false;
  const directories = new Map(parsed.directories);
  if (directories.get("") !== identity(await fs.lstat(root, { bigint: true }))) return false;
  const since = BigInt(Math.floor(sinceMs)) * 1_000_000n;
  let unchanged = true;
  const complete = await walkTaskDirectory(root, (relative, stat) => {
    unchanged = stat.isDirectory() ? directories.get(relative) === identity(stat)
      : (stat.ctimeNs > stat.mtimeNs ? stat.ctimeNs : stat.mtimeNs) < since;
    return unchanged;
  }, { ...options, recorded: new Map(parsed.dependencies) });
  // The walk stops at the first changed entry, so `unchanged` is final.
  return complete && unchanged;
}

const NO_REPLACE = new Set(["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR"]);
/** Opening a directory without following a symlink fails with these when
 * the entry is no longer a directory. */
const NOT_A_DIRECTORY = new Set(["ELOOP", "ENOTDIR", "ENOENT"]);

type OpenDirectory = { handle: FileHandle; path: string; stat: BigIntStats };

/** Open the directory at `at` without following a final symlink. Its entries
 * are then reached through `/proc/self/fd`, so every operation stays in the
 * directory that was opened even if its path is replaced meanwhile. Returns
 * null when the entry is no longer a directory. Fails closed where that
 * cannot be guaranteed. */
async function openDirectory(at: string): Promise<OpenDirectory | null> {
  const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW } = fsConstants;
  if (process.platform !== "linux" || O_DIRECTORY === undefined || O_NOFOLLOW === undefined) {
    throw new TaskDirectoryRestoreFailure("task_directory_containment_unavailable");
  }
  const handle = await fs.open(at, O_RDONLY | O_DIRECTORY | O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => {
    if (NOT_A_DIRECTORY.has(error.code ?? "")) return null;
    throw error;
  });
  if (!handle) return null;
  try {
    const stat = await handle.stat({ bigint: true });
    const by = `/proc/self/fd/${handle.fd}`;
    if (!stat.isDirectory() || identity(await fs.stat(by, { bigint: true })) !== identity(stat)) {
      throw new TaskDirectoryRestoreFailure("task_directory_containment_unavailable");
    }
    return { handle, path: by, stat };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Link into `target` every entry of `source` that `target` lacks, never
 * replacing anything there: a missing directory is created and filled, and a
 * missing file or symlink is hard-linked, both of which fail rather than
 * replace an entry made meanwhile. A partly removed folder keeps all it still
 * holds, including work written into it while this runs, and gains the rest
 * of the rebuilt folder. Directories take the mode saved in `source`. Both
 * folders must be on one filesystem.
 *
 * Every directory is worked on through an open handle, never by path, so a
 * directory replaced by a symlink after it was checked is neither followed
 * nor written through: an entry that is no longer a directory when opened is
 * left as it is. Returns the identity of the target directory it filled. */
export async function fillMissingTaskDirectoryEntries(source: string, target: string, signal?: AbortSignal) {
  const keep = (error: NodeJS.ErrnoException) => {
    if (NO_REPLACE.has(error.code ?? "")) return false;
    throw error;
  };
  const writable = async (directory: OpenDirectory) => {
    const mode = Number(directory.stat.mode);
    if ((mode & 0o700) !== 0o700) await directory.handle.chmod((mode & 0o7777) | 0o700);
  };
  const visit = async (from: OpenDirectory, to: OpenDirectory) => {
    signal?.throwIfAborted();
    for (const name of (await fs.readdir(from.path)).sort(bySortKey)) {
      const fromEntry = path.join(from.path, name);
      const toEntry = path.join(to.path, name);
      if (!(await fs.lstat(fromEntry)).isDirectory()) {
        if (!await fs.lstat(toEntry).catch(missing(null))) await fs.link(fromEntry, toEntry).catch(keep);
        continue;
      }
      await fs.mkdir(toEntry, { mode: 0o700 }).catch(keep);
      const fromChild = await openDirectory(fromEntry);
      if (!fromChild) throw new Error("unsafe_task_directory_staging");
      try {
        const toChild = await openDirectory(toEntry);
        if (!toChild) continue;
        try {
          await writable(fromChild);
          await writable(toChild);
          await visit(fromChild, toChild);
          await toChild.handle.chmod(Number(fromChild.stat.mode) & 0o7777);
        } finally {
          await toChild.handle.close();
        }
      } finally {
        await fromChild.handle.close();
      }
    }
  };
  const to = await openDirectory(target);
  if (!to) throw new Error("unsafe_task_directory_trash");
  try {
    const from = await openDirectory(source);
    if (!from) throw new Error("unsafe_task_directory_staging");
    try {
      await writable(from);
      await writable(to);
      await visit(from, to);
      await to.handle.chmod(Number(from.stat.mode) & 0o7777);
    } finally {
      await from.handle.close();
    }
    return identity(to.stat);
  } finally {
    await to.handle.close();
  }
}

/** Whether the directory at `target`, without following a symlink, is the
 * one `fillMissingTaskDirectoryEntries` returned. */
export async function isTaskDirectory(target: string, expected: string) {
  const stat = await fs.lstat(target, { bigint: true }).catch(missing(null));
  return Boolean(stat?.isDirectory()) && identity(stat!) === expected;
}

export async function removeTaskDirectoryTree(target: string) {
  const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("unsafe_task_directory_trash");
  const makeWritable = async (directory: string) => {
    await fs.chmod(directory, 0o700);
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await makeWritable(path.join(directory, entry.name));
    }
  };
  await makeWritable(target).catch(() => undefined);
  await fs.rm(target, { recursive: true, force: true });
}
