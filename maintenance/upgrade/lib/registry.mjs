import { readFileSync } from "node:fs";

export const PATCH_DECISIONS = Object.freeze(["unassessed", "keep", "adapt", "retire"]);
const SHA = /^[0-9a-f]{40}$/;
const TEST_FILE = /\.test\.(?:ts|tsx|mts|js|mjs)$/;
const SOURCE_FILE = /\.(?:ts|tsx|mts|js|mjs|cjs)$/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const PORT_ROOT = "maintenance/upgrade/ports/";
const safeRelative = (file) => !file.startsWith("/") && !file.split("/").includes("..");

const patchWhere = (patch, index) => `patches[${index}]${patch?.id ? ` (${patch.id})` : ""}`;

/**
 * `sourcePaths` optionally narrows what a group takes from a source commit:
 * full source SHA -> the exact repository paths of that commit the group owns.
 */
function validateSourcePaths(patch, where, fail) {
  const scopes = patch.sourcePaths;
  if (!scopes || typeof scopes !== "object" || Array.isArray(scopes)) { fail(`${where}: sourcePaths must map source commits to path lists`); return; }
  for (const [sha, paths] of Object.entries(scopes)) {
    if (!Array.isArray(patch.sourceCommits) || !patch.sourceCommits.includes(sha)) fail(`${where}: sourcePaths key ${sha} is not one of its sourceCommits`);
    if (!Array.isArray(paths) || paths.length === 0) { fail(`${where}: sourcePaths[${sha}] must be a non-empty path list`); continue; }
    if (paths.some((file) => typeof file !== "string" || !file || !safeRelative(file))) fail(`${where}: sourcePaths[${sha}] must hold relative repository paths`);
    if (new Set(paths).size !== paths.length) fail(`${where}: sourcePaths[${sha}] repeats a path`);
  }
}

/**
 * A commit cited by more than one group must be split by path: every claiming
 * group declares its own scope for it, and the scopes are pairwise disjoint.
 */
function validateSharedCommits(patches, fail) {
  const claims = new Map();
  for (const [index, patch] of patches.entries()) {
    if (!Array.isArray(patch?.sourceCommits)) continue;
    for (const sha of new Set(patch.sourceCommits)) {
      if (!claims.has(sha)) claims.set(sha, []);
      claims.get(sha).push({ patch, where: patchWhere(patch, index) });
    }
  }
  for (const [sha, claimants] of claims) {
    if (claimants.length < 2) continue;
    const owner = new Map();
    for (const { patch, where } of claimants) {
      const scope = patch.sourcePaths?.[sha];
      if (!Array.isArray(scope) || scope.length === 0) { fail(`${where}: shares source commit ${sha} with another group, so it needs sourcePaths for it`); continue; }
      for (const file of scope) {
        if (owner.has(file) && owner.get(file) !== where) fail(`${where}: sourcePaths for shared commit ${sha} must be disjoint; ${file} is also scoped by ${owner.get(file)}`);
        else owner.set(file, where);
      }
    }
  }
}

export function loadRegistry(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Structural validation only. A valid registry enforces nothing by itself. */
export function validateRegistry(registry) {
  const errors = [];
  const fail = (message) => errors.push(message);
  if (!registry || typeof registry !== "object") return ["registry must be an object"];
  if (registry.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (!SHA.test(registry.firstCandidateUpstreamSha ?? "")) fail("firstCandidateUpstreamSha must be a full SHA");
  if (!SHA.test(registry.forkPatchSourceSha ?? "")) fail("forkPatchSourceSha must be a full SHA");
  if (registry.automaticActivationEnabled !== false && !registry.controlledUpgradeProof) {
    fail("automaticActivationEnabled must stay false until a controlled upgrade proof is recorded");
  }
  if (registry.requiredCiJobs !== undefined && (!Array.isArray(registry.requiredCiJobs) || registry.requiredCiJobs.length === 0
    || registry.requiredCiJobs.some((name) => typeof name !== "string" || !name))) {
    fail("requiredCiJobs must be a non-empty array of check names");
  }
  if (registry.ciGraphDigest !== undefined && !/^[0-9a-f]{64}$/.test(registry.ciGraphDigest)) fail("ciGraphDigest must be a sha256 digest");
  if (!Array.isArray(registry.patches) || registry.patches.length === 0) {
    fail("patches must be a non-empty array");
    return errors;
  }
  const ids = new Set();
  validateSharedCommits(registry.patches, fail);
  for (const [index, patch] of registry.patches.entries()) {
    const where = patchWhere(patch, index);
    if (!patch?.id || typeof patch.id !== "string") { fail(`${where}: id is required`); continue; }
    if (ids.has(patch.id)) fail(`${where}: duplicate id`);
    ids.add(patch.id);
    if (!PATCH_DECISIONS.includes(patch.decision)) fail(`${where}: decision must be one of ${PATCH_DECISIONS.join(", ")}`);
    if (!Array.isArray(patch.sourceCommits) || patch.sourceCommits.length === 0 || !patch.sourceCommits.every((sha) => SHA.test(sha))) {
      fail(`${where}: sourceCommits must be full SHAs`);
    }
    if (!Array.isArray(patch.evidencePaths) || patch.evidencePaths.length === 0) fail(`${where}: evidencePaths are required`);
    if (patch.sourcePaths !== undefined) validateSourcePaths(patch, where, fail);
    const upstreamOnly = patch.upstreamOnly;
    if (!upstreamOnly) { fail(`${where}: upstreamOnly evaluation is required`); continue; }
    if (upstreamOnly.kind === "manual-review") {
      if (typeof upstreamOnly.reason !== "string" || !upstreamOnly.reason.trim()) fail(`${where}: manual-review needs a reason`);
      continue;
    }
    if (upstreamOnly.kind !== "vitest") { fail(`${where}: upstreamOnly.kind must be vitest or manual-review`); continue; }
    if (upstreamOnly.sourceSha !== undefined && !SHA.test(upstreamOnly.sourceSha)) fail(`${where}: upstreamOnly.sourceSha must be a full SHA`);
    if (!Array.isArray(upstreamOnly.testFiles) || upstreamOnly.testFiles.length === 0) fail(`${where}: upstreamOnly.testFiles are required`);
    else for (const file of upstreamOnly.testFiles) if (!TEST_FILE.test(file)) fail(`${where}: ${file} is not a test file`);
    if (upstreamOnly.exportShim !== undefined) {
      if (!Array.isArray(upstreamOnly.exportShim) || upstreamOnly.exportShim.length === 0) fail(`${where}: exportShim must be a non-empty array`);
      else for (const shim of upstreamOnly.exportShim) {
        if (typeof shim?.file !== "string" || !SOURCE_FILE.test(shim.file) || TEST_FILE.test(shim.file) || !safeRelative(shim.file)) fail(`${where}: exportShim file must be a relative non-test source path`);
        if (!Array.isArray(shim?.symbols) || shim.symbols.length === 0 || shim.symbols.some((name) => !IDENTIFIER.test(name ?? ""))) fail(`${where}: exportShim symbols must be identifiers`);
      }
    }
    if (upstreamOnly.ports !== undefined) {
      if (!Array.isArray(upstreamOnly.ports) || upstreamOnly.ports.length === 0) fail(`${where}: ports must be a non-empty array`);
      else for (const port of upstreamOnly.ports) {
        if (typeof port?.port !== "string" || !port.port.startsWith(PORT_ROOT) || !TEST_FILE.test(port.port) || !safeRelative(port.port)) fail(`${where}: port must be a test file under ${PORT_ROOT}`);
        if (!Array.isArray(upstreamOnly.testFiles) || !upstreamOnly.testFiles.includes(port?.target)) fail(`${where}: port target must be a declared test file`);
      }
    }
    if (upstreamOnly.requiredTests !== undefined && (!Array.isArray(upstreamOnly.requiredTests) || upstreamOnly.requiredTests.some((t) => typeof t !== "string" || !t))) {
      fail(`${where}: requiredTests must be non-empty strings`);
    }
  }
  return errors;
}

/**
 * Provenance against actual commits. `readCommit(sha)` returns `{ files }`, the
 * paths the commit changed against its first parent, or `{ unavailable }`.
 * Each source commit must change a path its group declares: its scope for that
 * commit when present (every scoped path must be changed), otherwise one of the
 * group's evidence paths. A missing commit is unknown, never a pass.
 */
export function checkRegistryProvenance(registry, readCommit) {
  const errors = validateRegistry(registry);
  const unknown = [];
  for (const [index, patch] of (Array.isArray(registry?.patches) ? registry.patches : []).entries()) {
    const where = patchWhere(patch, index);
    for (const sha of Array.isArray(patch?.sourceCommits) ? patch.sourceCommits : []) {
      const commit = readCommit(sha);
      if (!commit || !Array.isArray(commit.files)) { unknown.push(`${where}: ${sha}: ${commit?.unavailable ?? "unavailable"}`); continue; }
      const changed = new Set(commit.files);
      const scope = patch.sourcePaths?.[sha];
      if (Array.isArray(scope)) {
        for (const file of scope) if (!changed.has(file)) errors.push(`${where}: source commit ${sha} does not change scoped path ${file}`);
      } else if (!(patch.evidencePaths ?? []).some((file) => changed.has(file))) {
        errors.push(`${where}: source commit ${sha} touches none of its declared paths (${(patch.evidencePaths ?? []).join(", ")})`);
      }
    }
  }
  return { status: errors.length > 0 ? "fail" : unknown.length > 0 ? "unknown" : "pass", errors, unknown };
}
