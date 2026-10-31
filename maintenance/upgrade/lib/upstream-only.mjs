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
  for (const sha of [upstreamSha, sourceSha]) {
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
    const content = blob(repo, sourceSha, file);
    if (content === null) { receipt.reasons.push(`fork-test-missing:${file}`); continue; }
    const upstream = blob(repo, upstreamSha, file);
    overlay.push({ file, content });
    receipt.overlay.push({
      file,
      forkBlob: git(repo, ["rev-parse", `${sourceSha}:${file}`]).trim(),
      forkSha256: sha256(content),
      upstreamSha256: upstream ? sha256(upstream) : null,
    });
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
    // Prove the only difference from upstream is the declared test overlay.
    const changed = git(tree, ["status", "--porcelain", "--untracked-files=all"]).split("\n").filter(Boolean).map((line) => line.slice(3));
    const unexpected = changed.filter((file) => !spec.testFiles.includes(file));
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
    receipt.test = run(expand(testArgv, { report: reportPath, testFiles: spec.testFiles }), tree, timeoutMs, env);
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
