import path from "node:path";

/**
 * Agent keys may tighten a local run sandbox but never widen it.
 *
 * The sandbox is what keeps service lifecycle control (install, update,
 * restart) out of agent runs, and it lives in mutable adapter config. An agent
 * that could clear `filesystemScope`, loosen `networkScope`, or add mounts or
 * network targets could hand any agent's next run the host account. Only a
 * board operator may make those changes.
 */

type Record_ = Record<string, unknown>;

const NETWORK_SCOPE_STRENGTH: Record<string, number> = { deny: 2, allowlist: 1 };

function networkStrength(value: unknown): number {
  return typeof value === "string" ? NETWORK_SCOPE_STRENGTH[value] ?? 0 : 0;
}

function extraPathGrants(value: unknown): Map<string, "ro" | "rw"> {
  const grants = new Map<string, "ro" | "rw">();
  if (!Array.isArray(value)) return grants;
  for (const entry of value) {
    const raw = typeof entry === "string" ? { path: entry, access: "ro" } : entry;
    if (!raw || typeof raw !== "object" || typeof (raw as Record_).path !== "string") continue;
    const access = (raw as Record_).access === "rw" ? "rw" : "ro";
    const key = path.resolve(((raw as Record_).path as string).trim() || "/");
    if (grants.get(key) !== "rw") grants.set(key, access);
  }
  return grants;
}

function allowlistEntries(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim().toLowerCase()));
}

/** The sandbox settings `next` widens relative to `existing`; empty when none. */
export function listAgentSandboxWidening(existing: Record_ | null | undefined, next: Record_ | null | undefined): string[] {
  const before = existing ?? {};
  const after = next ?? {};
  const widened: string[] = [];
  if (before.filesystemScope === "workspace" && after.filesystemScope !== "workspace") widened.push("filesystemScope");
  if (networkStrength(after.networkScope) < networkStrength(before.networkScope)) widened.push("networkScope");
  const beforePaths = extraPathGrants(before.filesystemExtraPaths);
  for (const [grantPath, access] of extraPathGrants(after.filesystemExtraPaths)) {
    const held = beforePaths.get(grantPath);
    if (!held || (access === "rw" && held !== "rw")) {
      widened.push("filesystemExtraPaths");
      break;
    }
  }
  const beforeAllowlist = allowlistEntries(before.networkAllowlist);
  for (const entry of allowlistEntries(after.networkAllowlist)) {
    if (!beforeAllowlist.has(entry)) {
      widened.push("networkAllowlist");
      break;
    }
  }
  return widened;
}
