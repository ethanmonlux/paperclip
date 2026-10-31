import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { evaluateUpstreamOnly, installEnv, minimalEnv } from "../lib/upstream-only.mjs";

// Hermetic identity: hosts may export empty GIT_AUTHOR_* variables.
const identity = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, ...identity } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function commit(repo, files, message) {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), content);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

// The fake runner records what it saw and writes a Vitest-shaped report whose
// outcome depends on whether the upstream source contains the fix marker.
const runner = `
const fs = require("node:fs");
const [report, ...files] = process.argv.slice(1);
const source = fs.readFileSync("src/impl.js", "utf8");
const test = fs.readFileSync(files[0], "utf8");
fs.writeFileSync("observed.json", JSON.stringify({ source, test, envKeys: Object.keys(process.env) }));
const fixed = source.includes("FIXED");
fs.writeFileSync(report, JSON.stringify({ testResults: [{ name: require("node:path").resolve(files[0]), status: fixed ? "passed" : "failed", message: "",
  assertionResults: [{ fullName: "impl keeps output", status: fixed ? "passed" : "failed",
    failureMessages: fixed ? [] : ["AssertionError: expected 'upstream rewrite' to contain 'FIXED'"] }] }] }));
process.exit(fixed ? 0 : 1);
`;

function fixture(upstreamFixed) {
  const dir = mkdtempSync(path.join(tmpdir(), "upstream-only-"));
  const repo = path.join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q");
  const base = commit(repo, { "src/impl.js": "base\n", "src/impl.test.ts": "old test\n" }, "base");
  const fork = commit(repo, { "src/impl.js": "base FIXED-by-fork\n", "src/impl.test.ts": "fork regression test\n" }, "fork");
  git(repo, "checkout", "-q", "--detach", base);
  const upstream = commit(repo, { "src/impl.js": upstreamFixed ? "upstream FIXED\n" : "upstream rewrite\n", "README": "x\n" }, "upstream");
  const patch = { id: "p1", upstreamOnly: { kind: "vitest", testFiles: ["src/impl.test.ts"], requiredTests: ["keeps output"] } };
  const run = (overrides = {}) => evaluateUpstreamOnly({
    repo, patch, upstreamSha: upstream, forkSha: fork, workDir: path.join(dir, "work"),
    testArgv: [process.execPath, "-e", runner, "{report}", "{testFiles}"],
    keepWorktree: true, ...overrides,
  });
  return { dir, repo, fork, upstream, patch, run, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("runs the fork's test against upstream source without the patch source", () => {
  const f = fixture(false);
  try {
    const receipt = f.run();
    assert.equal(receipt.outcome, "upstream-fails");
    assert.equal(receipt.upstreamSha, f.upstream);
    assert.equal(receipt.forkSourceSha, f.fork);
    assert.deepEqual(receipt.overlayChangedFiles, ["src/impl.test.ts"]);
    const observed = JSON.parse(readFileSync(path.join(f.dir, "work", "upstream-p1", "observed.json"), "utf8"));
    assert.equal(observed.source, "upstream rewrite\n", "patch source must not be copied");
    assert.equal(observed.test, "fork regression test\n");
    assert.match(receipt.overlay[0].forkSha256, /^[0-9a-f]{64}$/);
  } finally { f.cleanup(); }
});

test("reports upstream-passes only from an actual green run, and never decides", () => {
  const f = fixture(true);
  try {
    const receipt = f.run({ keepWorktree: false });
    assert.equal(receipt.outcome, "upstream-passes");
    assert.equal(receipt.decision, undefined);
    assert.equal(git(f.repo, "worktree", "list").split("\n").length, 1, "worktree is removed");
  } finally { f.cleanup(); }
});

test("runs tests with a minimal allowlisted environment, not host credentials", () => {
  const f = fixture(true);
  process.env.UPSTREAM_ONLY_TEST_SECRET_TOKEN = "must-not-leak";
  try {
    f.run();
    const observed = JSON.parse(readFileSync(path.join(f.dir, "work", "upstream-p1", "observed.json"), "utf8"));
    assert.ok(!observed.envKeys.includes("UPSTREAM_ONLY_TEST_SECRET_TOKEN"));
    assert.ok(!observed.envKeys.includes("PAPERCLIP_API_KEY"));
    assert.ok(observed.envKeys.includes("CI"));
  } finally { delete process.env.UPSTREAM_ONLY_TEST_SECRET_TOKEN; f.cleanup(); }
});

test("install gets proxy and cache settings but never credentials; tests do not", () => {
  const host = {
    PATH: "/bin", HOME: "/h", HTTPS_PROXY: "http://127.0.0.1:3128", https_proxy: "http://user:pw@proxy.invalid:1",
    HTTP_PROXY: "not a url", npm_config_store_dir: "/tmp/store", COREPACK_HOME: "/ro/corepack", PAPERCLIP_API_KEY: "secret", GITHUB_TOKEN: "secret",
  };
  assert.deepEqual(minimalEnv(host), { CI: "1", PATH: "/bin", HOME: "/h", COREPACK_HOME: "/ro/corepack" });
  assert.deepEqual(installEnv(host), {
    CI: "1", PATH: "/bin", HOME: "/h", COREPACK_HOME: "/ro/corepack", HTTPS_PROXY: "http://127.0.0.1:3128", npm_config_store_dir: "/tmp/store",
  });
  const f = fixture(true);
  try {
    const receipt = f.run({
      installArgv: [process.execPath, "-e", "require('node:fs').writeFileSync('install-env.json', JSON.stringify(Object.keys(process.env)))"],
      installEnvironment: installEnv(host),
      env: { CI: "1", PATH: process.env.PATH },
    });
    assert.equal(receipt.outcome, "upstream-passes");
    const work = path.join(f.dir, "work", "upstream-p1");
    assert.ok(JSON.parse(readFileSync(path.join(work, "install-env.json"), "utf8")).includes("HTTPS_PROXY"));
    assert.ok(!JSON.parse(readFileSync(path.join(work, "observed.json"), "utf8")).envKeys.includes("HTTPS_PROXY"));
  } finally { f.cleanup(); }
});

test("missing fork tests, unavailable commits, failed installs and missing runners are unknown", () => {
  const f = fixture(true);
  try {
    const missing = f.run({ patch: { id: "p2", upstreamOnly: { kind: "vitest", testFiles: ["src/gone.test.ts"] } } });
    assert.deepEqual([missing.outcome, missing.reasons], ["unknown", ["fork-test-missing:src/gone.test.ts"]]);
    const absent = f.run({ forkSha: "0".repeat(40) });
    assert.deepEqual([absent.outcome, absent.reasons], ["unknown", [`commit-unavailable:${"0".repeat(40)}`]]);
    const install = f.run({ patch: { ...f.patch, id: "p3" }, installArgv: [process.execPath, "-e", "process.exit(3)"] });
    assert.deepEqual([install.outcome, install.reasons], ["unknown", ["install-failed"]]);
    const noRunner = f.run({ patch: { ...f.patch, id: "p4" }, testArgv: ["definitely-not-a-runner-binary"] });
    assert.equal(noRunner.outcome, "unknown");
    assert.equal(noRunner.test.spawnError, "ENOENT");
    assert.deepEqual(noRunner.reasons, ["runner-spawn-failed:ENOENT", "report-missing-or-malformed"]);
  } finally { f.cleanup(); }
});

test("manual-review patches are not automated", () => {
  const f = fixture(true);
  try {
    const receipt = f.run({ patch: { id: "ci", upstreamOnly: { kind: "manual-review", reason: "workflow pin" } } });
    assert.deepEqual([receipt.outcome, receipt.reasons], ["unknown", ["not-automatable:workflow pin"]]);
  } finally { f.cleanup(); }
});

test("refuses to overlay non-test paths", () => {
  const f = fixture(true);
  try {
    assert.throws(() => f.run({ patch: { id: "bad", upstreamOnly: { kind: "vitest", testFiles: ["src/impl.js"] } } }), /non-test path/);
    assert.throws(() => f.run({ patch: { id: "bad2", upstreamOnly: { kind: "vitest", testFiles: ["../x.test.ts"] } } }), /non-test path/);
  } finally { f.cleanup(); }
});
