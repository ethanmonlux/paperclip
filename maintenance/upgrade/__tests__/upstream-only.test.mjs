import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { applyExportShim, evaluateUpstreamOnly, installEnv, minimalEnv, receiptDigest, verifyExportOnlyDiff } from "../lib/upstream-only.mjs";

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
    testIsolation: "none", keepWorktree: true, ...overrides,
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
    const observed = JSON.parse(readFileSync(path.join(receipt.attemptDir, "upstream", "observed.json"), "utf8"));
    assert.equal(observed.source, "upstream rewrite\n", "patch source must not be copied");
    assert.equal(observed.test, "fork regression test\n");
    assert.match(receipt.overlay[0].forkSha256, /^[0-9a-f]{64}$/);
    assert.equal(receipt.overlay[0].forkBlob, git(f.repo, "rev-parse", `${f.fork}:src/impl.test.ts`));
    assert.equal(receipt.upstreamTree, git(f.repo, "rev-parse", `${f.upstream}^{tree}`));
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
    const receipt = f.run();
    const observed = JSON.parse(readFileSync(path.join(receipt.attemptDir, "upstream", "observed.json"), "utf8"));
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
    const work = path.join(receipt.attemptDir, "upstream");
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

test("a later attempt that writes no report is unknown, never an earlier attempt's pass", () => {
  const f = fixture(true);
  try {
    const first = f.run({ keepWorktree: false });
    assert.equal(first.outcome, "upstream-passes");
    assert.ok(existsSync(first.report.path), "the first attempt's report is retained");
    // Same patch, same output directory; the runner exits 0 without a report.
    const second = f.run({ keepWorktree: false, testArgv: [process.execPath, "-e", "process.exit(0)"] });
    assert.equal(second.outcome, "unknown");
    assert.deepEqual(second.reasons, ["report-missing-or-malformed"]);
    assert.equal(second.report, null);
    assert.notEqual(second.attemptId, first.attemptId);
    assert.notEqual(second.attemptDir, first.attemptDir);
    assert.notEqual(receiptDigest(second), receiptDigest(first));
    assert.equal(git(f.repo, "worktree", "list").split("\n").length, 1, "worktrees are removed");
  } finally { f.cleanup(); }
});

test("a report naming another attempt's worktree does not count", () => {
  const f = fixture(true);
  try {
    const first = f.run({ keepWorktree: false });
    // The runner copies the first attempt's passing report into this attempt's slot.
    const copy = `require("node:fs").copyFileSync(${JSON.stringify(first.report.path)}, process.argv[1])`;
    const second = f.run({ keepWorktree: false, testArgv: [process.execPath, "-e", copy, "{report}"] });
    assert.equal(second.outcome, "unknown");
  } finally { f.cleanup(); }
});

test("receipt digests are stable across a JSON round trip and change with content", () => {
  const f = fixture(false);
  try {
    const receipt = f.run({ keepWorktree: false });
    assert.equal(receiptDigest(JSON.parse(JSON.stringify(receipt, null, 2))), receiptDigest(receipt));
    assert.notEqual(receiptDigest({ ...receipt, outcome: "upstream-passes" }), receiptDigest(receipt));
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

test("export shims add only the export keyword and leave exported symbols alone", () => {
  const source = "const a = 1;\nasync function hidden(port) {\n  return port;\n}\nexport function shown() {}\nfunction other() {}\n";
  const { text, applied } = applyExportShim(source, ["hidden", "shown"]);
  assert.equal(text, source.replace("async function hidden", "export async function hidden"));
  assert.deepEqual(applied, [{ symbol: "hidden", action: "exported" }, { symbol: "shown", action: "already-exported" }]);
  assert.ok(verifyExportOnlyDiff(source, text));
  assert.ok(!verifyExportOnlyDiff(source, text.replace("return port", "return 0")));
  assert.throws(() => applyExportShim(source, ["missing"]), /exactly one top-level declaration/);
  assert.throws(() => applyExportShim("function x() {}\nfunction x() {}\n", ["x"]), /exactly one/);
  assert.throws(() => applyExportShim(source, ["a;b"]), /Invalid shim symbol/);
  // An indented (nested) declaration is not a module-level symbol.
  assert.throws(() => applyExportShim("{\n  function nested() {}\n}\n", ["nested"]), /exactly one/);
});

test("an export shim reaches upstream's own private code and is recorded", () => {
  const f = fixture(false);
  try {
    const hidden = commit(f.repo, { "src/impl.js": "function hidden() { return 'upstream rewrite'; }\n" }, "upstream private");
    const shimRunner = `
const fs = require("node:fs");
const [report, ...files] = process.argv.slice(1);
const source = fs.readFileSync("src/impl.js", "utf8");
const exported = source.startsWith("export function hidden(");
fs.writeFileSync(report, JSON.stringify({ testResults: [{ name: require("node:path").resolve(files[0]), status: "failed", message: "",
  assertionResults: [{ fullName: "impl keeps output", status: exported ? "failed" : "failed",
    failureMessages: [exported ? "AssertionError: expected 'upstream rewrite' to contain 'FIXED'" : "TypeError: hidden is not a function"] }] }] }));
process.exit(1);
`;
    const patch = { ...f.patch, upstreamOnly: { ...f.patch.upstreamOnly, exportShim: [{ file: "src/impl.js", symbols: ["hidden"] }] } };
    const receipt = f.run({ patch, upstreamSha: hidden, testArgv: [process.execPath, "-e", shimRunner, "{report}", "{testFiles}"] });
    assert.equal(receipt.outcome, "upstream-fails");
    assert.deepEqual(receipt.shim[0].applied, [{ symbol: "hidden", action: "exported" }]);
    assert.match(receipt.shim[0].upstreamSha256, /^[0-9a-f]{64}$/);
    assert.notEqual(receipt.shim[0].upstreamSha256, receipt.shim[0].shimmedSha256);
    assert.deepEqual([...receipt.overlayChangedFiles].sort(), ["src/impl.js", "src/impl.test.ts"]);
    // Without the shim the same regression cannot reach upstream's code.
    const plain = f.run({ upstreamSha: hidden, testArgv: [process.execPath, "-e", shimRunner, "{report}", "{testFiles}"] });
    assert.equal(plain.outcome, "unknown");
  } finally { f.cleanup(); }
});

test("a committed port replaces the original regression and is bound to its blob", () => {
  const f = fixture(false);
  try {
    const portPath = "maintenance/upgrade/ports/p1/impl.test.ts";
    git(f.repo, "checkout", "-q", "--detach", f.fork);
    const portSha = commit(f.repo, { [portPath]: "ported regression test\n" }, "port");
    const patch = { ...f.patch, upstreamOnly: { ...f.patch.upstreamOnly, ports: [{ port: portPath, target: "src/impl.test.ts" }] } };
    assert.throws(() => f.run({ patch }), /portSourceSha/);
    const receipt = f.run({ patch, portSourceSha: portSha });
    assert.equal(receipt.outcome, "upstream-fails");
    assert.equal(receipt.portSourceSha, portSha);
    assert.equal(receipt.overlay[0].port.blob, git(f.repo, "rev-parse", `${portSha}:${portPath}`));
    assert.equal(receipt.overlay[0].forkBlob, git(f.repo, "rev-parse", `${f.fork}:src/impl.test.ts`), "original stays recorded");
    const observed = JSON.parse(readFileSync(path.join(receipt.attemptDir, "upstream", "observed.json"), "utf8"));
    assert.equal(observed.test, "ported regression test\n");
    // A working-tree edit is never what runs: only the committed port blob.
    writeFileSync(path.join(f.repo, portPath), "uncommitted edit\n");
    const again = f.run({ patch, portSourceSha: portSha });
    assert.equal(JSON.parse(readFileSync(path.join(again.attemptDir, "upstream", "observed.json"), "utf8")).test, "ported regression test\n");
    const missing = f.run({ patch: { ...patch, upstreamOnly: { ...patch.upstreamOnly, ports: [{ port: "maintenance/upgrade/ports/p1/absent.test.ts", target: "src/impl.test.ts" }] } }, portSourceSha: portSha });
    assert.equal(missing.outcome, "unknown");
    assert.deepEqual(missing.reasons, ["port-missing:maintenance/upgrade/ports/p1/absent.test.ts"]);
    assert.throws(() => f.run({ patch: { ...patch, upstreamOnly: { ...patch.upstreamOnly, ports: [{ port: portPath, target: "src/other.test.ts" }] } }, portSourceSha: portSha }), /not a declared test file/);
  } finally { f.cleanup(); }
});

const canIsolate = spawnSync("unshare", ["--user", "--map-root-user", "--net", "sh", "-c", "ip link set lo up"]).status === 0;
// CI sets this so the isolation proof can never silently skip there.
const requireIsolation = process.env.UPGRADE_TOOLKIT_REQUIRE_ISOLATION === "1";

test("private-network isolation frees host-held ports and is recorded", { skip: canIsolate || requireIsolation ? false : "user/network namespaces unavailable on this host" }, async () => {
  assert.ok(canIsolate, "user/network namespaces are required but unavailable");
  const net = await import("node:net");
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const f = fixture(true);
  try {
    // The runner must bind the port the host holds; it reports pass only if it can.
    const bindRunner = `
const fs = require("node:fs"); const net = require("node:net");
const [report, ...files] = process.argv.slice(1);
const s = net.createServer();
const done = (ok, msg) => { fs.writeFileSync(report, JSON.stringify({ testResults: [{ name: require("node:path").resolve(files[0]), status: ok ? "passed" : "failed", message: "",
  assertionResults: [{ fullName: "impl keeps output", status: ok ? "passed" : "failed", failureMessages: ok ? [] : [msg] }] }] })); process.exit(ok ? 0 : 1); };
s.on("error", (e) => done(false, "Error: " + e.code));
s.listen(${port}, "127.0.0.1", () => s.close(() => done(true)));
`;
    const argv = [process.execPath, "-e", bindRunner, "{report}", "{testFiles}"];
    const host = f.run({ testArgv: argv, testIsolation: "none" });
    assert.equal(host.outcome, "unknown");
    assert.deepEqual(host.reasons, ["non-assertion-failure:impl keeps output"]);
    const isolated = f.run({ testArgv: argv, testIsolation: "private-network" });
    assert.equal(isolated.outcome, "upstream-passes");
    assert.equal(isolated.testIsolation, "private-network");
    assert.equal(isolated.test.argv[0], "unshare");
    assert.throws(() => f.run({ testIsolation: "bogus" }), /Unknown test isolation/);
  } finally { server.close(); f.cleanup(); }
});

test("private-network-user isolation keeps the private network but runs as the caller's own uid", { skip: canIsolate || requireIsolation ? false : "user/network namespaces unavailable on this host" }, async () => {
  assert.ok(canIsolate, "user/network namespaces are required but unavailable");
  const net = await import("node:net");
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const f = fixture(true);
  try {
    // Passes only if the host-held port is free (private network) and the
    // process is the caller's uid/gid, not namespace root.
    const runner = `
const fs = require("node:fs"); const net = require("node:net");
const [report, ...files] = process.argv.slice(1);
fs.writeFileSync("ids.json", JSON.stringify({ uid: process.getuid(), gid: process.getgid() }));
const s = net.createServer();
const done = (ok, msg) => { fs.writeFileSync(report, JSON.stringify({ testResults: [{ name: require("node:path").resolve(files[0]), status: ok ? "passed" : "failed", message: "",
  assertionResults: [{ fullName: "impl keeps output", status: ok ? "passed" : "failed", failureMessages: ok ? [] : [msg] }] }] })); process.exit(ok ? 0 : 1); };
s.on("error", (e) => done(false, "Error: " + e.code));
s.listen(${port}, "127.0.0.1", () => s.close(() => done(${process.getuid()} === process.getuid() && ${process.getgid()} === process.getgid(), "AssertionError: wrong uid")));
`;
    const argv = [process.execPath, "-e", runner, "{report}", "{testFiles}"];
    const asRoot = f.run({ testArgv: argv, testIsolation: "private-network" });
    assert.deepEqual(JSON.parse(readFileSync(path.join(asRoot.attemptDir, "upstream", "ids.json"), "utf8")), { uid: 0, gid: 0 });
    const asUser = f.run({ testArgv: argv, testIsolation: "private-network-user" });
    assert.equal(asUser.outcome, "upstream-passes", asUser.test.outputTail);
    assert.equal(asUser.testIsolation, "private-network-user");
    assert.deepEqual(JSON.parse(readFileSync(path.join(asUser.attemptDir, "upstream", "ids.json"), "utf8")), { uid: process.getuid(), gid: process.getgid() });
  } finally { server.close(); f.cleanup(); }
});
