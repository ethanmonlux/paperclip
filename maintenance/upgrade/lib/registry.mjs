import { readFileSync } from "node:fs";

export const PATCH_DECISIONS = Object.freeze(["unassessed", "keep", "adapt", "retire"]);
const SHA = /^[0-9a-f]{40}$/;
const TEST_FILE = /\.test\.(?:ts|tsx|mts|js|mjs)$/;
const SOURCE_FILE = /\.(?:ts|tsx|mts|js|mjs|cjs)$/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const PORT_ROOT = "maintenance/upgrade/ports/";
const safeRelative = (file) => !file.startsWith("/") && !file.split("/").includes("..");

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
  for (const [index, patch] of registry.patches.entries()) {
    const where = `patches[${index}]${patch?.id ? ` (${patch.id})` : ""}`;
    if (!patch?.id || typeof patch.id !== "string") { fail(`${where}: id is required`); continue; }
    if (ids.has(patch.id)) fail(`${where}: duplicate id`);
    ids.add(patch.id);
    if (!PATCH_DECISIONS.includes(patch.decision)) fail(`${where}: decision must be one of ${PATCH_DECISIONS.join(", ")}`);
    if (!Array.isArray(patch.sourceCommits) || patch.sourceCommits.length === 0 || !patch.sourceCommits.every((sha) => SHA.test(sha))) {
      fail(`${where}: sourceCommits must be full SHAs`);
    }
    if (!Array.isArray(patch.evidencePaths) || patch.evidencePaths.length === 0) fail(`${where}: evidencePaths are required`);
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
