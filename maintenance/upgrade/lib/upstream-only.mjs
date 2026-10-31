import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonicalDigest, sha256 } from "./digest.mjs";
import { classifyVitestReport } from "./vitest-report.mjs";

export const RECEIPT_SCHEMA = "staple.upgrade.upstream-only.v2";
const SHA = /^[0-9a-f]{40}$/;
const TEST_FILE = /\.test\.(?:ts|tsx|mts|js|mjs)$/;
// Tests get a fixed, minimal environment: no host credentials or tokens.
// Corepack settings locate the pinned package manager without downloading it.
const ENV_ALLOWLIST = ["PATH", "HOME", "TMPDIR", "LANG", "TZ", "COREPACK_HOME", "COREPACK_ENABLE_DOWNLOAD_PROMPT", "COREPACK_ENABLE_AUTO_PIN"];
// The install step additionally needs the egress proxy and private package
// caches. Proxy URLs that embed credentials are dropped rather than forwarded.
const INSTALL_ENV_ALLOWLIST = [
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "NODE_USE_ENV_PROXY",
  "npm_config_cache", "npm_config_store_dir",
];
const PROXY_KEY = /^(?:https?_proxy)$/i;
const DEFAULT_TEST_ARGV = ["pnpm", "exec", "vitest", "run", "--reporter=json", "--outputFile={report}", "{testFiles}"];
const PORT_ROOT = "maintenance/upgrade/ports/";
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
// Tests run in a fresh user and network namespace with only loopback up, so a
// fixed port held by the host (for example a sandbox proxy) cannot turn a
// listen failure into a fake behavioral result, and tests reach no network.
// `private-network-user` then drops back to the caller's own uid/gid in a
// nested user namespace, for tests that refuse to run as root (embedded
// Postgres `initdb`); the network namespace stays the same.
export const TEST_ISOLATION = Object.freeze({
  "private-network": (argv) => ["unshare", "--user", "--map-root-user", "--net", "sh", "-c", 'ip link set lo up && exec "$@"', "sh", ...argv],
  "private-network-user": (argv) => ["unshare", "--user", "--map-root-user", "--net", "sh", "-c",
    `ip link set lo up && exec unshare --user --map-user=${process.getuid()} --map-group=${process.getgid()} "$@"`, "sh", ...argv],
  none: (argv) => argv,
});

function git(repo, args, options = {}) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: options.encoding ?? "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr).trim()}`);
  return result.stdout;
}

function blob(repo, sha, file) {
  const result = spawnSync("git", ["-C", repo, "show", `${sha}:${file}`], { maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

/** The identity a review cites; any change to a retained receipt changes it. */
export const receiptDigest = (receipt) => canonicalDigest(receipt);

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Export module-private declarations so an original regression can import
 * them. Only the `export ` keyword is added; the declaration and every other
 * byte stay upstream's. A symbol that is already exported is left alone.
 */
export function applyExportShim(source, symbols) {
  let text = source;
  const applied = [];
  for (const symbol of symbols) {
    if (!IDENTIFIER.test(symbol)) throw new Error(`Invalid shim symbol ${symbol}`);
    const name = escapeRegExp(symbol);
    const exported = text.match(new RegExp(`^export\\s+(?:async\\s+)?function\\*?\\s+${name}\\s*[(<]`, "gm")) ?? [];
    const local = text.match(new RegExp(`^(?:async\\s+)?function\\*?\\s+${name}\\s*[(<]`, "gm")) ?? [];
    if (exported.length === 1 && local.length === 0) { applied.push({ symbol, action: "already-exported" }); continue; }
    if (local.length !== 1 || exported.length !== 0) throw new Error(`Shim symbol ${symbol} must have exactly one top-level declaration`);
    text = text.replace(new RegExp(`^((?:async\\s+)?function\\*?\\s+${name}\\s*[(<])`, "m"), "export $1");
    applied.push({ symbol, action: "exported" });
  }
  return { text, applied };
}

/** Prove a shimmed file differs from its source only by added `export ` keywords. */
export function verifyExportOnlyDiff(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length !== b.length) return false;
  return a.every((line, index) => line === b[index] || b[index] === `export ${line}`);
}

export function minimalEnv(source = process.env) {
  const env = { CI: "1" };
  for (const key of ENV_ALLOWLIST) if (source[key] !== undefined) env[key] = source[key];
  return env;
}

function proxyHasCredentials(value) {
  try {
    const url = new URL(value);
    return Boolean(url.username || url.password);
  } catch {
    return true;
  }
}

export function installEnv(source = process.env) {
  const env = minimalEnv(source);
  for (const key of INSTALL_ENV_ALLOWLIST) {
    const value = source[key];
    if (value === undefined) continue;
    if (PROXY_KEY.test(key) && proxyHasCredentials(value)) continue;
    env[key] = value;
  }
  return env;
}

function expand(argv, values) {
  return argv.flatMap((arg) => arg === "{testFiles}" ? values.testFiles : [arg.replaceAll("{report}", values.report)]);
}

function run(argv, cwd, timeoutMs, env) {
  const started = Date.now();
  const result = spawnSync(argv[0], argv.slice(1), { cwd, env, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return {
    argv,
    exitCode: result.status,
    signal: result.signal,
    timedOut: result.error?.code === "ETIMEDOUT",
    spawnError: result.error && result.error.code !== "ETIMEDOUT" ? result.error.code ?? result.error.message : null,
    durationMs: Date.now() - started,
    outputTail: `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-4000),
  };
}

/**
 * Run one patch's original regression files against an exact upstream tree
 * WITHOUT the patch source. Only test files are copied from the fork; the
 * receipt never decides keep/adapt/retire.
 */
export function evaluateUpstreamOnly({
  repo,
  patch,
  upstreamSha,
  forkSha,
  workDir,
  installArgv = null,
  testArgv = DEFAULT_TEST_ARGV,
  testIsolation = "private-network",
  portSourceSha = null,
  timeoutMs = 20 * 60_000,
  env = minimalEnv(),
  installEnvironment = installEnv(),
  now = () => new Date(),
  keepWorktree = false,
}) {
  const spec = patch.upstreamOnly;
  const sourceSha = spec?.sourceSha ?? forkSha;
  const receipt = {
    schema: RECEIPT_SCHEMA,
    attemptId: randomUUID(),
    patchId: patch.id,
    upstreamSha,
    upstreamTree: null,
    forkSourceSha: sourceSha,
    startedAt: now().toISOString(),
    nodeVersion: process.version,
    overlay: [],
    shim: [],
    testIsolation,
    portSourceSha: null,
    install: null,
    test: null,
    report: null,
    outcome: "unknown",
    reasons: [],
  };
  const finish = () => ({ ...receipt, finishedAt: now().toISOString() });
  if (spec?.kind !== "vitest") {
    receipt.reasons.push(`not-automatable:${spec?.reason ?? "no upstreamOnly spec"}`);
    return finish();
  }
  if (!SHA.test(upstreamSha) || !SHA.test(sourceSha)) throw new Error("upstreamSha and the fork source SHA must be full SHAs");
  if (!Object.hasOwn(TEST_ISOLATION, testIsolation)) throw new Error(`Unknown test isolation ${testIsolation}`);
  const ports = spec.ports ?? [];
  const shims = spec.exportShim ?? [];
  if (ports.length > 0) {
    if (!SHA.test(portSourceSha ?? "")) throw new Error("ports need a full portSourceSha");
    receipt.portSourceSha = portSourceSha;
  }
  for (const sha of [upstreamSha, sourceSha, ...(ports.length > 0 ? [portSourceSha] : [])]) {
    if (spawnSync("git", ["-C", repo, "cat-file", "-e", `${sha}^{commit}`]).status !== 0) {
      receipt.reasons.push(`commit-unavailable:${sha}`);
    }
  }
  if (receipt.reasons.length > 0) return finish();
  receipt.upstreamTree = git(repo, ["rev-parse", `${upstreamSha}^{tree}`]).trim();

  const overlay = [];
  for (const file of spec.testFiles) {
    if (!TEST_FILE.test(file) || path.isAbsolute(file) || file.split("/").includes("..")) {
      throw new Error(`Refusing to overlay non-test path ${file}`);
    }
    const original = blob(repo, sourceSha, file);
    if (original === null) { receipt.reasons.push(`fork-test-missing:${file}`); continue; }
    const upstream = blob(repo, upstreamSha, file);
    const entry = {
      file,
      forkBlob: git(repo, ["rev-parse", `${sourceSha}:${file}`]).trim(),
      forkSha256: sha256(original),
      upstreamSha256: upstream ? sha256(upstream) : null,
    };
    // A reviewed port of the original regression replaces it; its committed
    // blob, never a working-tree file, is what runs and what the receipt binds.
    const port = ports.find((candidate) => candidate.target === file);
    let content = original;
    if (port) {
      content = blob(repo, portSourceSha, port.port);
      if (content === null) { receipt.reasons.push(`port-missing:${port.port}`); continue; }
      entry.port = { path: port.port, blob: git(repo, ["rev-parse", `${portSourceSha}:${port.port}`]).trim(), sha256: sha256(content) };
    }
    overlay.push({ file, content });
    receipt.overlay.push(entry);
  }
  for (const port of ports) {
    if (!spec.testFiles.includes(port.target)) throw new Error(`Port target ${port.target} is not a declared test file`);
  }
  if (receipt.reasons.length > 0) return finish();

  // Every attempt gets its own fresh directory for the worktree and the report,
  // so output from an earlier attempt can never be read as this attempt's
  // result. The report and the receipt stay there after the worktree is removed.
  mkdirSync(workDir, { recursive: true });
  const attemptDir = mkdtempSync(path.join(workDir, `attempt-${patch.id}-`));
  receipt.attemptDir = attemptDir;
  const tree = path.join(attemptDir, "upstream");
  const reportPath = path.join(attemptDir, "report.json");
  git(repo, ["worktree", "add", "--detach", tree, upstreamSha]);
  try {
    const head = git(tree, ["rev-parse", "HEAD"]).trim();
    if (head !== upstreamSha) throw new Error(`worktree HEAD ${head} is not ${upstreamSha}`);
    for (const { file, content } of overlay) {
      const target = path.join(tree, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    for (const { file, symbols } of shims) {
      const target = path.join(tree, file);
      const before = readFileSync(target, "utf8");
      const { text, applied } = applyExportShim(before, symbols);
      if (!verifyExportOnlyDiff(before, text)) throw new Error(`Shim of ${file} changed more than export keywords`);
      writeFileSync(target, text);
      receipt.shim.push({ file, upstreamSha256: sha256(Buffer.from(before)), shimmedSha256: sha256(Buffer.from(text)), applied });
    }
    // Prove the only differences from upstream are the declared test overlay
    // and export-only shims.
    const allowed = new Set([...spec.testFiles, ...shims.filter((_, i) => receipt.shim[i].applied.some((a) => a.action === "exported")).map((s) => s.file)]);
    const changed = git(tree, ["status", "--porcelain", "--untracked-files=all"]).split("\n").filter(Boolean).map((line) => line.slice(3));
    const unexpected = changed.filter((file) => !allowed.has(file));
    if (unexpected.length > 0) throw new Error(`Unexpected upstream tree changes: ${unexpected.join(", ")}`);
    receipt.overlayChangedFiles = changed;

    if (installArgv) {
      receipt.install = run(installArgv, tree, timeoutMs, installEnvironment);
      if (receipt.install.exitCode !== 0) {
        receipt.reasons.push("install-failed");
        return finish();
      }
    }
    if (existsSync(reportPath)) throw new Error(`Report ${reportPath} exists before the test run`);
    receipt.test = run(TEST_ISOLATION[testIsolation](expand(testArgv, { report: reportPath, testFiles: spec.testFiles })), tree, timeoutMs, env);
    if (receipt.test.spawnError) receipt.reasons.push(`runner-spawn-failed:${receipt.test.spawnError}`);
    const reportBytes = existsSync(reportPath) ? readFileSync(reportPath) : null;
    let report = null;
    try { report = reportBytes ? JSON.parse(reportBytes.toString("utf8")) : null; } catch { report = null; }
    const classified = classifyVitestReport({
      report,
      exitCode: receipt.test.timedOut ? null : receipt.test.exitCode,
      root: tree,
      testFiles: spec.testFiles,
      requiredTests: spec.requiredTests ?? [],
    });
    receipt.report = report ? { path: reportPath, sha256: sha256(reportBytes), bytes: reportBytes.length, counts: classified.counts } : null;
    receipt.outcome = receipt.test.timedOut || receipt.test.signal ? "unknown" : classified.outcome;
    receipt.reasons.push(...classified.reasons);
    if (receipt.test.timedOut) receipt.reasons.push("timed-out");
    else if (receipt.test.signal) receipt.reasons.push(`signal:${receipt.test.signal}`);
    return finish();
  } finally {
    if (!keepWorktree) git(repo, ["worktree", "remove", "--force", tree]);
  }
}
