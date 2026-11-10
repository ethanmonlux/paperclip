import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// STA-223: the nightly certification runs the complete trusted suite on one commit and records
// `staple/certified`; PR CI keeps the single stable aggregate `ci / verify`.
const root = new URL("../../../", import.meta.url);
const read = (file) => readFileSync(new URL(file, root), "utf8");
const certify = read(".github/workflows/staple-certify.yml");
const trusted = read(".github/workflows/pr-trusted.yml");

const job = (workflow, name) => {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `missing job ${name}`);
  const rest = workflow.slice(start + 1);
  const end = rest.slice(1).search(/\n  [a-z_]+:\n/);
  return end < 0 ? rest : rest.slice(0, end + 1);
};

test("runs nightly at 22:45 Denver standard time and on demand, after the upgrade-relevant sync", () => {
  assert.match(certify, /schedule:\n\s+- cron: "45 5 \* \* \*"/);
  assert.match(certify, /\n  workflow_dispatch:\n/);
  assert.match(certify, /statuses: write/);
  assert.match(certify, /cancel-in-progress: false/);
});

test("certifies with the complete trusted suite and records every verdict as staple/certified", () => {
  assert.match(job(certify, "ci"), /uses: \.\/\.github\/workflows\/pr-trusted\.yml/);
  assert.doesNotMatch(job(certify, "ci"), /with:/, "no input may narrow the certified suite");
  assert.match(job(certify, "mark_pending"), /state=pending -f context=staple\/certified/);
  const record = job(certify, "record");
  assert.match(record, /needs: \[mark_pending, ci\]/);
  assert.match(record, /if: \$\{\{ always\(\) \}\}/);
  assert.match(record, /context=staple\/certified/);
  assert.match(record, /SUITE_RESULT: \$\{\{ needs\.ci\.result \}\}/);
});

test("only a successful suite certifies: failure is failure, anything else is error", () => {
  const script = job(certify, "record").split("        run: |\n")[1].split("\n").map((line) => line.slice(10)).join("\n");
  const dir = mkdtempSync(path.join(tmpdir(), "staple-certify-record-"));
  try {
    const log = path.join(dir, "gh.log");
    writeFileSync(path.join(dir, "gh"), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\n`, { mode: 0o755 });
    for (const [result, state] of [["success", "success"], ["failure", "failure"], ["cancelled", "error"], ["skipped", "error"]]) {
      writeFileSync(log, "");
      let code = 0;
      try {
        execFileSync("bash", ["-c", script], { env: { ...process.env, BASH_ENV: "", PATH: `${dir}:${process.env.PATH}`, SUITE_RESULT: result,
          GITHUB_REPOSITORY: "ethanmonlux/paperclip", GITHUB_SHA: "a".repeat(40), GITHUB_RUN_ID: "1", RUN_URL: "https://example.invalid/run",
          GITHUB_STEP_SUMMARY: path.join(dir, "summary") }, stdio: "pipe" });
      } catch (error) { code = error.status; }
      const call = readFileSync(log, "utf8");
      assert.match(call, new RegExp(`statuses/${"a".repeat(40)} -f state=${state} -f context=staple/certified`), result);
      assert.equal(code === 0, state === "success", `${result} exit code`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the trusted suite runs outside pull_request: PR-diff checks are PR-only and runs never cancel each other", () => {
  assert.match(trusted, /group: \$\{\{ github\.event_name == 'pull_request' && format\('pr-\{0\}', github\.event\.pull_request\.number\) \|\| format\('ci-certify-\{0\}', github\.sha\) \}\}/);
  assert.match(trusted, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  for (const step of ["Block untrusted lockfile edits", "Validate migration ordering against target branch",
    "Verify release package bootstrap for changed manifests"]) {
    const block = trusted.split(`      - name: ${step}\n`)[1].split("\n      - name: ")[0];
    assert.match(block, /if: github\.event_name == 'pull_request'/, step);
  }
  // Every other use of pull_request event data sits in those steps, the concurrency group or a harmless env value.
  const outside = trusted.split("\n").filter((line) => /github\.event\.pull_request\.(base|head)\.sha/.test(line));
  assert.ok(outside.length <= 6, outside.join("\n"));
});

test("ci / verify is the single stable aggregate and covers e2e too", () => {
  const verify = job(trusted, "verify");
  assert.match(verify, /name: verify\n/);
  assert.match(verify, /if: \$\{\{ always\(\) \}\}/);
  assert.match(verify, /needs: \[[^\]]*\be2e_shards\]/);
  const matrixJobs = Object.keys(JSON.parse(read(".github/ci-task-matrix.json")));
  const checked = JSON.parse(verify.match(/for \(const job of (\[[^\]]+\])\)/)[1]);
  assert.deepEqual([...checked].sort(), [...matrixJobs].sort(), "verify must judge every planned suite");
  // The Staple scope may turn file-level Vitest selection on for the fork.
  assert.match(job(trusted, "test_selection"), /fromJSON\(needs\.gate\.outputs\.plan\)\.staple\.vitestSelection == true/);
});
