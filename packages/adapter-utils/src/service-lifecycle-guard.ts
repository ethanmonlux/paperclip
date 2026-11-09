import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Service lifecycle authority for confined agent runs.
 *
 * Agent runs share the Linux user that owns the Paperclip service, so any path
 * the sandbox exposes from that user's account is reachable from a run. The
 * paths below are what install, update and restart need: the systemd user
 * manager and session bus (under the user runtime directory), the CLI board
 * credential, the managed install store, the user's command shims and the
 * systemd user units. A confined run never needs any of them.
 *
 * - `hide`: the run sees nothing there. A read-only bind is not enough for the
 *   runtime directory because connecting to a Unix socket ignores the mount's
 *   read-only flag.
 * - `read_only`: the run may read (for example skill files shipped inside the
 *   install payload) but never write.
 *
 * The guard is applied after every other mount, so no agent configuration
 * (`filesystemExtraPaths`, a workspace under the home directory, or
 * network-only confinement that binds the host root) can reopen it.
 */
export type ServiceLifecycleGuardProtection = "hide" | "read_only";

export interface ServiceLifecycleGuardPath {
  path: string;
  protect: ServiceLifecycleGuardProtection;
}

export interface ServiceLifecycleGuardMount {
  path: string;
  access: "ro" | "rw";
}

function uniqueAbsolute(paths: Array<string | null | undefined>): string[] {
  const result = new Set<string>();
  for (const candidate of paths) {
    const trimmed = candidate?.trim();
    if (trimmed && path.isAbsolute(trimmed)) result.add(path.resolve(trimmed));
  }
  return Array.from(result);
}

export function resolveServiceLifecycleGuardPaths(input: {
  homeDirs?: string[];
  paperclipHome?: string | null;
  uid?: number | null;
  env?: NodeJS.ProcessEnv;
} = {}): ServiceLifecycleGuardPath[] {
  const env = input.env ?? process.env;
  const homeDirs = uniqueAbsolute(input.homeDirs ?? [os.homedir(), safeUserInfoHome()]);
  const paperclipHomes = uniqueAbsolute([
    input.paperclipHome ?? env.PAPERCLIP_HOME,
    ...homeDirs.map((home) => path.join(home, ".paperclip")),
  ]);
  const uid = input.uid !== undefined ? input.uid : typeof process.getuid === "function" ? process.getuid() : null;
  const runtimeDirs = uniqueAbsolute([
    uid === null ? null : `/run/user/${uid}`,
    env.XDG_RUNTIME_DIR,
  ]);
  const configHomes = uniqueAbsolute([
    env.XDG_CONFIG_HOME,
    ...homeDirs.map((home) => path.join(home, ".config")),
  ]);

  return [
    ...runtimeDirs.map((dir) => ({ path: dir, protect: "hide" as const })),
    ...paperclipHomes.map((home) => ({ path: path.join(home, "auth.json"), protect: "hide" as const })),
    ...paperclipHomes.map((home) => ({ path: path.join(home, "cli"), protect: "read_only" as const })),
    ...homeDirs.map((home) => ({ path: path.join(home, ".local", "bin"), protect: "read_only" as const })),
    ...configHomes.map((home) => ({ path: path.join(home, "systemd"), protect: "read_only" as const })),
  ];
}

function safeUserInfoHome(): string | null {
  try {
    return os.userInfo().homedir;
  } catch {
    return null;
  }
}

function isSameOrInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Whether a mount makes the guarded path reachable with the access it forbids. */
export function mountReachesServiceLifecycleGuard(
  mount: ServiceLifecycleGuardMount,
  guard: ServiceLifecycleGuardPath,
): boolean {
  if (guard.protect === "read_only" && mount.access !== "rw") return false;
  return isSameOrInside(guard.path, mount.path) || isSameOrInside(mount.path, guard.path);
}

/**
 * Bubblewrap arguments that re-cover every guarded path a mount reaches. They
 * must follow all other mount arguments. Guarded paths missing on the host are
 * skipped: nothing can be mounted from them.
 */
export async function buildServiceLifecycleGuardArgs(input: {
  mounts: ServiceLifecycleGuardMount[];
  guards?: ServiceLifecycleGuardPath[];
  devNullPath?: string;
}): Promise<string[]> {
  const guards = input.guards ?? resolveServiceLifecycleGuardPaths();
  const args: string[] = [];
  const applied = new Set<string>();
  for (const guard of guards) {
    const key = `${guard.protect}:${guard.path}`;
    if (applied.has(key)) continue;
    if (!input.mounts.some((mount) => mountReachesServiceLifecycleGuard(mount, guard))) continue;
    const stat = await fs.stat(guard.path).catch(() => null);
    if (!stat) continue;
    applied.add(key);
    if (guard.protect === "read_only") {
      args.push("--ro-bind", guard.path, guard.path);
    } else if (stat.isDirectory()) {
      args.push("--tmpfs", guard.path);
    } else {
      args.push("--ro-bind", input.devNullPath ?? "/dev/null", guard.path);
    }
  }
  return args;
}
