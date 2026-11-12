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
const caller = read(".github/workflows/pr.yml");

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

// The aggregate's own program, run against chosen suite results.
function aggregate({ event, plan, results, fullCi = "true" }) {
  const verify = job(trusted, "verify");
  const names = verify.match(/needs: \[([^\]]+)\]/)[1].split(", ");
  const code = verify.split("          node --input-type=module <<'NODE'\n")[1].split("\n          NODE")[0]
    .split("\n").map((line) => line.slice(10)).join("\n");
  const all = Object.fromEntries(names.map((name) => [name, { result: results[name] ?? results["*"] }]));
  try {
    execFileSync(process.execPath, ["--input-type=module", "-e", code], { stdio: "pipe", env: { ...process.env, FULL_CI: fullCi,
      EVENT_NAME: event, CI_PLAN: plan ? JSON.stringify(plan) : "", CI_RESULTS: JSON.stringify(all) } });
    return true;
  } catch { return false; }
}

test("a certification verdict needs every suite to run and pass: no plan, no skipped or failed suite", () => {
  assert.match(job(trusted, "verify"), /EVENT_NAME: \$\{\{ github\.event_name \}\}/);
  // The certification has no plan, so the routine-only job is skipped and every suite runs.
  const complete = { "*": "success", affected_packages: "skipped", test_selection: "skipped" };
  for (const event of ["schedule", "workflow_dispatch"]) {
    assert.equal(aggregate({ event, plan: null, results: complete }), true, event);
    for (const suite of ["build", "typecheck_release_registry", "e2e_shards", "general_tests", "verify_serialized_server",
      "verify_paperclip_runner", "canary_dry_run", "docker_context_integrity", "sandbox_provider_tests", "verify_runner_e2e_support"]) {
      for (const result of ["skipped", "failure", "cancelled"]) {
        assert.equal(aggregate({ event, plan: null, results: { ...complete, [suite]: result } }), false, `${event}: ${suite} ${result}`);
      }
    }
    // A routine plan is for pull requests only. It can never stand behind a certification.
    const lanes = JSON.parse(read(".github/ci-task-matrix.json"));
    const routine = { version: 1, mode: "enabled", forceReason: null, jobs: Object.fromEntries(Object.keys(lanes).map((name) =>
      [name, { run: false }])), staple: { scope: "routine", affected: { run: false } } };
    const skipped = { "*": "skipped", gate: "success", policy: "success" };
    assert.equal(aggregate({ event: "pull_request", plan: routine, results: skipped }), true, "a routine pull request plan is valid");
    assert.equal(aggregate({ event, plan: routine, results: skipped }), false, `${event}: narrowed plan`);
    assert.equal(aggregate({ event, plan: null, results: skipped, fullCi: "false" }), false, `${event}: not full`);
  }
});

test("a routine push must pass the affected-package typecheck its plan asked for", () => {
  const affected = job(trusted, "affected_packages");
  assert.match(affected, /if: \$\{\{ needs\.gate\.outputs\.full_ci == 'true' && needs\.gate\.outputs\.plan != '' && fromJSON\(needs\.gate\.outputs\.plan\)\.staple\.affected\.run == true \}\}/);
  assert.match(affected, /run: node scripts\/ci\/affected-packages\.mjs/);
  const lanes = JSON.parse(read(".github/ci-task-matrix.json"));
  const plan = (run) => ({ version: 1, mode: "enabled", forceReason: null,
    jobs: Object.fromEntries(Object.keys(lanes).map((name) => [name, { run: false }])), staple: { scope: "routine", affected: { run } } });
  const base = { "*": "skipped", gate: "success", policy: "success" };
  assert.equal(aggregate({ event: "pull_request", plan: plan(true), results: { ...base, affected_packages: "success" } }), true);
  for (const result of ["skipped", "failure", "cancelled"]) {
    assert.equal(aggregate({ event: "pull_request", plan: plan(true), results: { ...base, affected_packages: result } }), false, result);
  }
  assert.equal(aggregate({ event: "pull_request", plan: plan(false), results: { ...base, affected_packages: "success" } }), false);
});

test("a push cancels only the superseded checks of its own pull request, never another pull request or a certification", () => {
  const ci = job(caller, "ci");
  assert.match(ci, /concurrency:\n\s+group: pr-checks-\$\{\{ github\.event\.pull_request\.number \}\}\n\s+cancel-in-progress: true/);
  // On the job: a run that an unrelated label skips never enters the group.
  assert.doesNotMatch(caller.split("\njobs:\n")[0], /concurrency:/);
  assert.match(ci, /if: github\.event\.action != 'labeled' \|\| github\.event\.label\.name == 'profile-ci' \|\| github\.event\.label\.name == 'full-ci'/);
  // One trigger: a pull request event. No push trigger runs the same checks twice.
  assert.deepEqual(caller.match(/^on:\n((?:  .*\n)+)/m)[1].trim().split("\n")[0], "pull_request:");
  assert.doesNotMatch(caller, /^  push:/m);
  // The groups differ by pull request number or by commit, and the two workflows never share one.
  const groups = (number, sha, event) => ({
    caller: `pr-checks-${number}`,
    trusted: event === "pull_request" ? `pr-${number}` : `ci-certify-${sha}`,
    certify: "staple-certification-refs/heads/master",
  });
  const a = groups(49, "a".repeat(40), "pull_request"), b = groups(53, "b".repeat(40), "pull_request"), nightly = groups("", "c".repeat(40), "schedule");
  assert.equal(new Set([a.caller, a.trusted, b.caller, b.trusted, nightly.trusted, nightly.certify]).size, 6);
  assert.match(certify, /group: staple-certification-\$\{\{ github\.ref \}\}\n\s+cancel-in-progress: false/);
});

test("the certification pins one commit: every job of the run tests the commit the verdict is recorded on", () => {
  // A schedule or dispatch run has one github.sha for its whole life. No job overrides the checkout ref.
  assert.doesNotMatch(certify, /\bref:/);
  assert.equal(certify.match(/statuses\/\$GITHUB_SHA/g).length, 2);
  const refs = trusted.split("\n").filter((line) => /^\s+ref: /.test(line));
  assert.deepEqual(refs, [], "a suite that checked out another ref would certify a commit it did not test");
});
