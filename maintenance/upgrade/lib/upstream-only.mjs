import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { classifyVitestReport } from "./vitest-report.mjs";

export const RECEIPT_SCHEMA = "staple.upgrade.upstream-only.v1";
const SHA = /^[0-9a-f]{40}$/;
const TEST_FILE = /\.test\.(?:ts|tsx|mts|js|mjs)$/;
// Tests get a fixed, minimal environment: no host credentials or tokens.
const ENV_ALLOWLIST = ["PATH", "HOME", "TMPDIR", "LANG", "TZ"];
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

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

function minimalEnv(source = process.env) {
  const env = { CI: "1" };
  for (const key of ENV_ALLOWLIST) if (source[key] !== undefined) env[key] = source[key];
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
  now = () => new Date(),
  keepWorktree = false,
}) {
  const spec = patch.upstreamOnly;
  const sourceSha = spec?.sourceSha ?? forkSha;
  const receipt = {
    schema: RECEIPT_SCHEMA,
    patchId: patch.id,
    upstreamSha,
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

  const overlay = [];
  for (const file of spec.testFiles) {
    if (!TEST_FILE.test(file) || path.isAbsolute(file) || file.split("/").includes("..")) {
      throw new Error(`Refusing to overlay non-test path ${file}`);
    }
    const content = blob(repo, sourceSha, file);
    if (content === null) { receipt.reasons.push(`fork-test-missing:${file}`); continue; }
    const upstream = blob(repo, upstreamSha, file);
    overlay.push({ file, content });
    receipt.overlay.push({ file, forkSha256: sha256(content), upstreamSha256: upstream ? sha256(upstream) : null });
  }
  if (receipt.reasons.length > 0) return finish();

  mkdirSync(workDir, { recursive: true });
  const tree = path.join(workDir, `upstream-${patch.id}`);
  if (existsSync(tree)) throw new Error(`Refusing to reuse existing worktree path ${tree}`);
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
      receipt.install = run(installArgv, tree, timeoutMs, env);
      if (receipt.install.exitCode !== 0) {
        receipt.reasons.push("install-failed");
        return finish();
      }
    }
    const reportPath = path.join(workDir, `report-${patch.id}.json`);
    receipt.test = run(expand(testArgv, { report: reportPath, testFiles: spec.testFiles }), tree, timeoutMs, env);
    if (receipt.test.spawnError) receipt.reasons.push(`runner-spawn-failed:${receipt.test.spawnError}`);
    let report = null;
    try { report = JSON.parse(readFileSync(reportPath, "utf8")); } catch { report = null; }
    const classified = classifyVitestReport({
      report,
      exitCode: receipt.test.timedOut ? null : receipt.test.exitCode,
      root: tree,
      testFiles: spec.testFiles,
      requiredTests: spec.requiredTests ?? [],
    });
    receipt.report = report ? { path: reportPath, sha256: sha256(readFileSync(reportPath)), counts: classified.counts } : null;
    receipt.outcome = receipt.test.timedOut || receipt.test.signal ? "unknown" : classified.outcome;
    receipt.reasons.push(...classified.reasons);
    if (receipt.test.timedOut) receipt.reasons.push("timed-out");
    else if (receipt.test.signal) receipt.reasons.push(`signal:${receipt.test.signal}`);
    return finish();
  } finally {
    if (!keepWorktree) git(repo, ["worktree", "remove", "--force", tree]);
  }
}
