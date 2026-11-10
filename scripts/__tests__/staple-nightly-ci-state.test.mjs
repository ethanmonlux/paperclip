import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// STA-224: the hourly watcher skipped d8023d05 and c0522501 as `red:merge-and-push` while that Docker
// job was still running; both succeeded minutes later. Gate 0 must report a pending wait, not a failure.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = path.join(repoRoot, "scripts", "staple", "staple-nightly-upgrade.sh");
const fixtureDir = path.join(repoRoot, "scripts", "__tests__", "fixtures", "staple-ci-state");

function loadFixture(name) {
  return JSON.parse(readFileSync(path.join(fixtureDir, `${name}.json`), "utf8"));
}

function ciState(checks, workflows) {
  const dir = mkdtempSync(path.join(tmpdir(), "staple-ci-state-"));
  try {
    const checksFile = path.join(dir, "check-runs.json");
    const workflowsFile = path.join(dir, "workflow-runs.json");
    writeFileSync(checksFile, typeof checks === "string" ? checks : JSON.stringify(checks));
    writeFileSync(workflowsFile, typeof workflows === "string" ? workflows : JSON.stringify(workflows));
    const result = spawnSync("bash", [script, "ci-state", checksFile, workflowsFile], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function responses(checkRuns, workflowRuns) {
  return [
    { total_count: checkRuns.length, check_runs: checkRuns },
    { total_count: workflowRuns.length, workflow_runs: workflowRuns },
  ];
}

// GitHub as the watcher saw it at `at`: finished jobs as recorded, started jobs in progress,
// later jobs not created yet.
function snapshotAt(fixture, at) {
  const t = Date.parse(at);
  const checkRuns = fixture.checkRuns
    .filter((run) => Date.parse(run.started_at) <= t)
    .map((run) => (Date.parse(run.completed_at) <= t ? run : { ...run, status: "in_progress", conclusion: null, completed_at: null }));
  const workflowRuns = fixture.workflowRuns
    .filter((run) => Date.parse(run.created_at) <= t)
    .map((run) => (Date.parse(run.updated_at) <= t ? run : { ...run, status: "in_progress", conclusion: null }));
  return responses(checkRuns, workflowRuns);
}

const check = (name, status, conclusion = null) => ({ name, status, conclusion });
const workflow = (name, status, conclusion = null) => ({ name, event: "push", status, conclusion });

for (const name of ["d8023d05", "c0522501"]) {
  test(`${name}: running merge-and-push at the watcher check is pending, then green on readback`, () => {
    const fixture = loadFixture(name);
    const during = ciState(...snapshotAt(fixture, fixture.watcherCheckedAt));
    assert.match(during, /^pending:/);
    assert.match(during, /\bmerge-and-push\b/);
    assert.match(during, /workflow Docker/);
    assert.doesNotMatch(during, /^red/);

    assert.equal(ciState(...responses(fixture.checkRuns, fixture.workflowRuns)), "green");
  });
}

test("queued jobs are pending", () => {
  assert.equal(ciState(...responses([check("build", "completed", "success"), check("merge-and-push", "queued")], [workflow("Docker", "queued")])),
    "pending:workflow Docker; merge-and-push");
});

test("a workflow still in progress before its jobs exist is pending, not green", () => {
  assert.equal(ciState(...responses([check("refresh", "completed", "success")], [workflow("Docker", "in_progress")])),
    "pending:workflow Docker");
});

test("a completed failure is red even while other jobs are still running", () => {
  assert.equal(ciState(...responses([check("merge-and-push", "in_progress"), check("build-and-push (linux/amd64, ubuntu-latest, amd64)", "completed", "failure")], [workflow("Docker", "in_progress")])),
    "red:build-and-push (linux/amd64, ubuntu-latest, amd64) (failure)");
});

for (const conclusion of ["startup_failure", "action_required", "cancelled", "timed_out"]) {
  test(`workflow ${conclusion} is red with its reason`, () => {
    assert.equal(ciState(...responses([check("refresh", "completed", "success")], [workflow("Docker", "completed", conclusion)])),
      `red:workflow Docker (${conclusion})`);
  });
}

test("a workflow run that failed with zero jobs is red, not none", () => {
  assert.equal(ciState(...responses([], [workflow("Docker", "completed", "failure")])), "red:workflow Docker (failure)");
});

test("no check runs is none and fails closed", () => {
  assert.equal(ciState(...responses([], [])), "none");
  assert.equal(ciState(...responses([], [workflow("Release", "completed", "skipped")])), "none");
});

test("unreadable or truncated GitHub responses are errors", () => {
  assert.equal(ciState("not json", responses([], [])[1]), "error:check-runs unreadable");
  assert.equal(ciState({ message: "API rate limit exceeded for 1.2.3.4." }, responses([], [])[1]),
    "error:check-runs unreadable (API rate limit exceeded for 1.2.3.4.)");
  assert.equal(ciState({ total_count: 120, check_runs: [check("build", "completed", "success")] }, responses([], [])[1]),
    "error:check-runs truncated (1 of 120)");
  assert.equal(ciState(responses([check("build", "completed", "success")], [])[0], "{}"), "error:workflow-runs unreadable");
});

test("Gate 0 installs only on green and treats pending as a quiet retry", () => {
  const source = readFileSync(script, "utf8");
  const gate = source.slice(source.indexOf("# Gate 0:"), source.indexOf("# Gate 1:"));
  assert.match(gate, /CI=\$\(ci_state "\$CI_CHECKS" "\$CI_RUNS"\)/);
  assert.match(gate, /actions\/runs\?head_sha=\$TARGET/);
  assert.match(gate, /^\s+green\) ;;$/m);
  assert.match(gate, /pending:\*\) say "pending, retry: [^\n]*\n\s+report "Waiting: [^\n]*exit 0 ;;/);
  assert.match(gate, /^\s+\*\) report "Skipped: [^\n]*CI is not green \(\$CI\)[^\n]*exit 0 ;;$/m);
  // The hourly watcher stays silent on a pending wait, as it does on a skip.
  assert.match(source, /\[\[ "\$1" == Skipped:\* \|\| "\$1" == Waiting:\* \]\]/);
});
