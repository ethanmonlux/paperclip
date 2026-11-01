import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as registryLib from "../lib/registry.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const registryPath = path.join(repoRoot, "maintenance", "patch-registry.json");
const { loadRegistry, validateRegistry } = registryLib;
// Loaded leniently so a missing adapter reads as a failed assertion, not a load error.
const registryGit = await import("../lib/registry-git.mjs").catch(() => ({}));
const UP = "8595efc20bda3ce20a9fbbf34a5d156a6fcf6d57";
const SOURCE = "b".repeat(40);

// The two commits R10 is about, as they exist in this repository's history.
const SANDBOX_ONLY = "904851063ddf5f83ae298cac97eea877b8b57771";
const MIXED = "2e6e2f4bec1225e2b3b863f04b163884184afe19";
const RUNNER_TEST = "packages/paperclip-runner/scripts/stage-runner-binary.test.mjs";

function provenance(registry, readCommit) {
  assert.equal(typeof registryLib.checkRegistryProvenance, "function", "checkRegistryProvenance is not implemented");
  return registryLib.checkRegistryProvenance(registry, readCommit);
}

function gitReader(repo) {
  assert.equal(typeof registryGit.commitFilesFromGit, "function", "commitFilesFromGit is not implemented");
  return (sha) => registryGit.commitFilesFromGit(repo, sha);
}

const manual = { kind: "manual-review", reason: "fixture" };
const group = (id, sourceCommits, evidencePaths, extra = {}) => ({ id, decision: "unassessed", sourceCommits, evidencePaths, upstreamOnly: manual, ...extra });
const registryOf = (...patches) => ({ schemaVersion: 1, firstCandidateUpstreamSha: UP, forkPatchSourceSha: SOURCE, automaticActivationEnabled: false, patches });
const lookup = (table) => (sha) => (table[sha] ? { files: table[sha] } : { unavailable: `commit ${sha} is not available` });

function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function commitFiles(repo, files, message) {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), text);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "--no-gpg-sign", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

// A disposable repository shaped like R10: one commit touches only the sandbox
// files, a later mixed commit also changes the runner fixture test.
function fixtureRepo(t) {
  const root = mkdtempSync(path.join(tmpdir(), "registry-provenance-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q");
  const base = commitFiles(repo, { "sandbox.ts": "0", "stdio.test.ts": "0", "runner.test.mjs": "0", "other.test.ts": "0" }, "base");
  const sandboxOnly = commitFiles(repo, { "sandbox.ts": "1", "stdio.test.ts": "1" }, "sandbox only");
  const mixed = commitFiles(repo, { "sandbox.ts": "2", "stdio.test.ts": "2", "runner.test.mjs": "2" }, "mixed");
  return { root, repo, base, sandboxOnly, mixed };
}

const scopedCorrect = (sandboxOnly, mixed) => registryOf(
  group("provider", [sandboxOnly, mixed], ["stdio.test.ts", "other.test.ts"], { sourcePaths: { [mixed]: ["sandbox.ts", "stdio.test.ts"] } }),
  group("fixtures", [mixed], ["runner.test.mjs"], { sourcePaths: { [mixed]: ["runner.test.mjs"] } }),
);

test("a commit claimed by two groups without path scopes is structurally invalid", () => {
  const shared = "c".repeat(40);
  const errors = validateRegistry(registryOf(group("a", [shared], ["a.test.ts"]), group("b", [shared], ["b.test.ts"])));
  assert.ok(errors.some((error) => error.includes(shared) && /sourcePaths/.test(error)), errors.join("\n"));
});

test("a shared commit with a scope in only one claiming group is structurally invalid", () => {
  const shared = "c".repeat(40);
  const errors = validateRegistry(registryOf(
    group("a", [shared], ["a.test.ts"], { sourcePaths: { [shared]: ["a.ts"] } }),
    group("b", [shared], ["b.test.ts"]),
  ));
  assert.ok(errors.some((error) => error.includes("(b)") && error.includes(shared)), errors.join("\n"));
});

test("overlapping path scopes on a shared commit are structurally invalid", () => {
  const shared = "c".repeat(40);
  const errors = validateRegistry(registryOf(
    group("a", [shared], ["a.test.ts"], { sourcePaths: { [shared]: ["a.ts", "both.ts"] } }),
    group("b", [shared], ["b.test.ts"], { sourcePaths: { [shared]: ["both.ts"] } }),
  ));
  assert.ok(errors.some((error) => error.includes("both.ts") && /disjoint/.test(error)), errors.join("\n"));
});

test("malformed sourcePaths are structurally invalid", () => {
  const commit = "c".repeat(40);
  const other = "d".repeat(40);
  const cases = [
    ["not an object", ["a.ts"]],
    ["key not a source commit", { [other]: ["a.ts"] }],
    ["empty scope", { [commit]: [] }],
    ["absolute path", { [commit]: ["/etc/passwd"] }],
    ["parent traversal", { [commit]: ["../a.ts"] }],
    ["duplicate path", { [commit]: ["a.ts", "a.ts"] }],
  ];
  for (const [label, sourcePaths] of cases) {
    const errors = validateRegistry(registryOf(group("a", [commit], ["a.test.ts"], { sourcePaths })));
    assert.ok(errors.some((error) => /sourcePaths/.test(error)), `${label}: ${errors.join("\n")}`);
  }
});

test("disjoint scopes on a shared commit are structurally valid", (t) => {
  const { sandboxOnly, mixed } = fixtureRepo(t);
  assert.deepEqual(validateRegistry(scopedCorrect(sandboxOnly, mixed)), []);
});

test("R10 shape: a source commit that touches none of its group's paths fails provenance", (t) => {
  const { repo, sandboxOnly } = fixtureRepo(t);
  const registry = registryOf(group("provider", [sandboxOnly], ["stdio.test.ts"]), group("fixtures", [sandboxOnly], ["runner.test.mjs"], { sourcePaths: undefined }));
  // Without scopes the shared commit is already structurally invalid; provenance must still name the wrong association.
  registry.patches[0].sourcePaths = { [sandboxOnly]: ["sandbox.ts", "stdio.test.ts"] };
  registry.patches[1].sourcePaths = { [sandboxOnly]: ["runner.test.mjs"] };
  const result = provenance(registry, gitReader(repo));
  assert.equal(result.status, "fail");
  assert.ok(result.errors.some((error) => error.includes("(fixtures)") && error.includes(sandboxOnly) && error.includes("runner.test.mjs")), result.errors.join("\n"));
});

test("R10 shape without scopes: a commit touching none of the evidence paths fails provenance", (t) => {
  const { repo, sandboxOnly } = fixtureRepo(t);
  const result = provenance(registryOf(group("fixtures", [sandboxOnly], ["runner.test.mjs"])), gitReader(repo));
  assert.equal(result.status, "fail");
  assert.ok(result.errors.some((error) => error.includes("(fixtures)") && error.includes(sandboxOnly) && /touches none/.test(error)), result.errors.join("\n"));
});

test("the corrected path-scoped association passes provenance", (t) => {
  const { repo, sandboxOnly, mixed } = fixtureRepo(t);
  const result = provenance(scopedCorrect(sandboxOnly, mixed), gitReader(repo));
  assert.deepEqual(result, { status: "pass", errors: [], unknown: [] });
});

test("a scope path the commit never changed fails provenance", (t) => {
  const { repo, sandboxOnly, mixed } = fixtureRepo(t);
  const registry = scopedCorrect(sandboxOnly, mixed);
  registry.patches[1].sourcePaths[mixed] = ["runner.test.mjs", "other.test.ts"];
  const result = provenance(registry, gitReader(repo));
  assert.equal(result.status, "fail");
  assert.ok(result.errors.some((error) => error.includes("(fixtures)") && error.includes("other.test.ts")), result.errors.join("\n"));
});

test("evidence paths a source commit never touched stay valid when it touches another declared path", (t) => {
  // Control for groups whose evidence includes pre-existing regressions or later files
  // (provider-output-and-mounts, claude-auth-provenance, native-comment-redelivery, fork-commitperclip-disable).
  const { repo, sandboxOnly } = fixtureRepo(t);
  const result = provenance(registryOf(group("provider", [sandboxOnly], ["stdio.test.ts", "other.test.ts", "later-file.json"])), gitReader(repo));
  assert.deepEqual(result, { status: "pass", errors: [], unknown: [] });
});

test("an unavailable commit is unknown, never pass", (t) => {
  const { repo, mixed } = fixtureRepo(t);
  const missing = "e".repeat(40);
  const result = provenance(registryOf(group("a", [missing], ["runner.test.mjs"]), group("b", [mixed], ["runner.test.mjs"])), gitReader(repo));
  assert.equal(result.status, "unknown");
  assert.deepEqual(result.errors, []);
  assert.ok(result.unknown.some((entry) => entry.includes("(a)") && entry.includes(missing)), result.unknown.join("\n"));
});

test("a shallow-boundary commit is unknown: its diff would otherwise list the whole tree", (t) => {
  const { root, repo, sandboxOnly, mixed } = fixtureRepo(t);
  const shallow = path.join(root, "shallow");
  const clone = spawnSync("git", ["clone", "-q", "--depth", "1", `file://${repo}`, shallow], { encoding: "utf8" });
  assert.equal(clone.status, 0, clone.stderr);
  assert.equal(git(shallow, "rev-parse", "HEAD"), mixed);
  // Without the boundary rule a grafted root reports every file as changed and would pass any association.
  const result = provenance(registryOf(group("fixtures", [mixed], ["other.test.ts"])), gitReader(shallow));
  assert.equal(result.status, "unknown");
  assert.ok(result.unknown.some((entry) => entry.includes(mixed)), result.unknown.join("\n"));
  assert.equal(provenance(registryOf(group("p", [sandboxOnly], ["stdio.test.ts"])), gitReader(shallow)).status, "unknown");
});

test("a definite failure outranks unknown commits", () => {
  const known = "a".repeat(40);
  const result = provenance(registryOf(group("a", [known], ["x.test.ts"]), group("b", ["f".repeat(40)], ["y.test.ts"])), lookup({ [known]: ["z.ts"] }));
  assert.equal(result.status, "fail");
  assert.equal(result.unknown.length, 1);
});

test("a registry that fails structural validation never passes provenance", () => {
  const known = "a".repeat(40);
  const result = provenance(registryOf(group("a", [known], ["x.test.ts"]), group("b", [known], ["x.test.ts"])), lookup({ [known]: ["x.test.ts"] }));
  assert.equal(result.status, "fail");
  assert.ok(result.errors.some((error) => /sourcePaths/.test(error)), result.errors.join("\n"));
});

test("the committed registry binds portable-runner-fixtures to the mixed commit, scoped to its test", () => {
  const registry = loadRegistry(registryPath);
  assert.deepEqual(validateRegistry(registry), []);
  const fixtures = registry.patches.find((patch) => patch.id === "portable-runner-fixtures");
  const provider = registry.patches.find((patch) => patch.id === "provider-output-and-mounts");
  assert.deepEqual(fixtures.sourceCommits, [MIXED]);
  assert.deepEqual(fixtures.sourcePaths, { [MIXED]: [RUNNER_TEST] });
  assert.ok(!fixtures.sourceCommits.includes(SANDBOX_ONLY));
  assert.ok(provider.sourceCommits.includes(MIXED) && !provider.sourcePaths[MIXED].includes(RUNNER_TEST));
  assert.equal(fixtures.decision, "unassessed");
  assert.equal(fixtures.upstreamOnly.kind, "manual-review");
});

test("against this repository's history the committed registry never fails and the R10 association never passes", () => {
  // In a depth-1 CI checkout these commits are unavailable, so both read unknown; with history they are decided.
  const registry = loadRegistry(registryPath);
  const corrected = provenance(registry, gitReader(repoRoot));
  assert.notEqual(corrected.status, "fail", corrected.errors.join("\n"));
  const r10 = structuredClone(registry);
  const fixtures = r10.patches.find((patch) => patch.id === "portable-runner-fixtures");
  fixtures.sourceCommits = [SANDBOX_ONLY];
  delete fixtures.sourcePaths;
  delete r10.patches.find((patch) => patch.id === "provider-output-and-mounts").sourcePaths;
  const wrong = provenance(r10, gitReader(repoRoot));
  assert.notEqual(wrong.status, "pass");
  if (corrected.status === "pass") {
    assert.equal(wrong.status, "fail");
    assert.ok(wrong.errors.some((error) => error.includes("(portable-runner-fixtures)") && error.includes(SANDBOX_ONLY)), wrong.errors.join("\n"));
  }
});
