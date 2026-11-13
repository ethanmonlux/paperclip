import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

// STA-223: the installer installs only the newest master commit the nightly full suite certified
// (`staple/certified` = success), and a red nightly becomes urgent-lane repair tasks.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = path.join(repoRoot, "scripts", "staple", "staple-nightly-upgrade.sh");
const redRun = path.join(repoRoot, "scripts", "__tests__", "fixtures", "staple-certify-red");

const sha = (name) => name.padEnd(40, "0");
const status = (state, context = "staple/certified") => ({ context, state });

/** Writes a first-parent chain (newest first) and per-commit statuses, then asks the installer to pick. */
function pick({ installed, chain, statuses = {}, passingRuns }) {
  const dir = mkdtempSync(path.join(tmpdir(), "staple-certified-"));
  try {
    writeFileSync(path.join(dir, "chain"), chain.map(sha).join("\n") + "\n");
    for (const [name, list] of Object.entries(statuses)) {
      writeFileSync(path.join(dir, `statuses-${sha(name)}.json`), JSON.stringify(list));
    }
    if (passingRuns) {
      writeFileSync(path.join(dir, "certify-runs.json"), JSON.stringify({
        workflow_runs: passingRuns.map((name) => ({ head_sha: sha(name), conclusion: "success" })),
      }));
    }
    const result = spawnSync("bash", [script, "certified-pick", sha(installed), path.join(dir, "chain")], {
      encoding: "utf8", env: { ...process.env, STAPLE_GITHUB_FIXTURES: dir },
    });
    assert.equal(result.status, 0, result.stderr);
    return { out: result.stdout.trim().replaceAll(/[0-9a-f]0{20,}/g, (value) => value.replace(/0+$/, "")), log: result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("refuses an uncertified newer commit and installs the newest certified one", () => {
  // m4 is master: uncertified. m3 failed its nightly, m2 is still running, m1 is certified.
  const result = pick({
    installed: "m0", chain: ["m4", "m3", "m2", "m1", "m0"],
    statuses: { m3: [status("failure")], m2: [status("pending")], m1: [status("success", "other"), status("success")] },
  });
  assert.equal(result.out, "target:m1 installed-in-chain:yes");
  assert.match(result.log, /m4000000 staple\/certified=missing/);
  assert.match(result.log, /m3000000 staple\/certified=failure/);
  assert.match(result.log, /m2000000 staple\/certified=pending/);
});

test("the current status for the context wins: a re-run that failed uncertifies the commit", () => {
  // GitHub lists statuses newest first.
  assert.equal(pick({ installed: "m0", chain: ["m2", "m1", "m0"],
    statuses: { m2: [status("failure"), status("success")], m1: [status("success")] } }).out, "target:m1 installed-in-chain:yes");
});

test("does nothing when the installed build is already the newest certified commit", () => {
  assert.equal(pick({ installed: "m1", chain: ["m3", "m2", "m1", "m0"], statuses: { m0: [status("success")] } }).out, "installed-newest");
});

test("never installs a certified commit older than the installed build", () => {
  // m1 is certified but older than the installed m2: reaching the installed commit stops the search.
  assert.equal(pick({ installed: "m2", chain: ["m3", "m2", "m1"], statuses: { m1: [status("success")] } }).out, "installed-newest");
});

test("fails closed when no commit in the window is certified", () => {
  assert.equal(pick({ installed: "zz", chain: ["m2", "m1"] }).out, "none");
  assert.equal(pick({ installed: "zz", chain: [] }).out, "error:empty history");
});

test("an installed build outside the window is flagged so the installer checks it moves forward", () => {
  assert.equal(pick({ installed: "zz", chain: ["m2", "m1"], statuses: { m1: [status("success")] } }).out, "target:m1 installed-in-chain:no");
});

test("a commit without a passing certification run is skipped without a status read", () => {
  // m2 carries a stray success status but no passing run; m1 has both.
  const result = pick({ installed: "m0", chain: ["m2", "m1", "m0"], passingRuns: ["m1"],
    statuses: { m2: [status("success")], m1: [status("success")] } });
  assert.equal(result.out, "target:m1 installed-in-chain:yes");
  assert.match(result.log, /m2000000 staple\/certified=missing \(no passing certification run\)/);
});

test("a broken change outside a PR's scope is caught by the nightly and never installed", () => {
  // A UI-only PR (m2) skipped the server suites it did not touch; its regression only shows in the
  // nightly full suite, which marks master red. The installer keeps the last certified commit, m1.
  // After the repair (m3) merges and an urgent dispatch certifies it, the next check installs m3.
  const red = { m2: [status("failure")], m1: [status("success")] };
  assert.equal(pick({ installed: "m1", chain: ["m2", "m1"], statuses: red }).out, "installed-newest");
  assert.equal(pick({ installed: "m1", chain: ["m3", "m2", "m1"], statuses: { ...red, m3: [status("pending")] } }).out, "installed-newest");
  assert.equal(pick({ installed: "m1", chain: ["m3", "m2", "m1"], statuses: { ...red, m3: [status("success")] } }).out, "target:m3 installed-in-chain:yes");
});

/** Fake Staple API: two repair agents, whose running runs the test sets. Records created issues. */
async function withStaple(running, action) {
  const created = [];
  const agents = [
    { id: "agent-engineer", name: "Workflow Engineer", status: "idle" },
    { id: "agent-repair", name: "Repair Engineer", status: "idle" },
    { id: "agent-other", name: "Workflow Coordinator", status: "idle" },
  ];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      assert.equal(req.headers.authorization, "Bearer staple-test-token");
      const send = (value) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value)); };
      if (req.method === "GET" && req.url.endsWith("/agents")) return send(agents);
      if (req.method === "GET" && req.url.includes("/heartbeat-runs?status=running")) {
        return send(running.map((agentId, index) => ({ id: `run-${index}`, agentId, status: "running" })));
      }
      if (req.method === "POST" && req.url.endsWith("/issues")) {
        const issue = JSON.parse(body);
        created.push(issue);
        return send({ id: `issue-${created.length}`, identifier: `STA-T${created.length}`, ...issue });
      }
      res.statusCode = 404; send({ error: "not found" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const home = mkdtempSync(path.join(tmpdir(), "staple-certify-home-"));
  mkdirSync(path.join(home, ".paperclip"));
  writeFileSync(path.join(home, ".paperclip", "auth.json"), JSON.stringify({ token: "staple-test-token" }));
  const report = async (...args) => {
    const { stdout } = await promisify(execFile)("bash", [script, "certify-report", ...args], { env: {
      ...process.env, HOME: home, STAPLE_GITHUB_FIXTURES: redRun, STAPLE_API: `http://127.0.0.1:${server.address().port}`,
      STAPLE_COMPANY_ID: "company-test",
    } });
    return stdout;
  };
  try {
    return await action({ report, created, home });
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
}

test("a simulated red nightly opens one critical repair task per failing suite, once", async () => {
  // Real GitHub data: run 42762197624 failed General tests (server (5/12)) and the verify aggregate.
  await withStaple([], async ({ report, created, home }) => {
    const out = await report();
    assert.match(out, /opened STA-T1 for General tests on 3c733e90, assigned to Workflow Engineer \(0 running\)/);
    assert.equal(created.length, 1, "the verify aggregate is not a separate repair");
    const [task] = created;
    assert.equal(task.title, "Nightly certification red: General tests on master 3c733e90");
    assert.equal(task.priority, "critical");
    assert.equal(task.status, "todo");
    assert.equal(task.assigneeAgentId, "agent-engineer");
    assert.match(task.description, /3c733e90399d73ca3c1829e69bd5a52f1c46ea09/);
    assert.match(task.description, /actions\/runs\/42762197624/);
    assert.match(task.description, /ci \/ General tests \(server \(5\/12\)\)/);
    assert.match(task.description, /Failed step: Run grouped general test suites through Turbo/);
    assert.match(task.description, /remote-workspace-cohort-migration\.test\.ts`: AssertionError: expected 6 to be 8/);
    assert.match(task.description, /workflow_dispatch/);
    assert.match(readFileSync(path.join(home, ".paperclip", "nightly", "certify-reported"), "utf8"), /^42762197624 \* 3c733e90/m);

    assert.match(await report(), /red run 42762197624 on 3c733e90 already reported/);
    assert.equal(created.length, 1, "a run is reported once");
  });
});

test("a busy Workflow Engineer hands the repair to the Repair Engineer", async () => {
  await withStaple(["agent-engineer"], async ({ report, created }) => {
    assert.match(await report(), /assigned to Repair Engineer \(0 running\)/);
    assert.equal(created[0].assigneeAgentId, "agent-repair");
  });
});

test("dry run prints the repair tasks without creating them or recording the run", async () => {
  await withStaple([], async ({ report, created, home }) => {
    const out = await report("--dry-run");
    assert.match(out, /DRY RUN: would open critical task 'Nightly certification red: General tests on master 3c733e90'/);
    assert.equal(created.length, 0);
    assert.throws(() => readFileSync(path.join(home, ".paperclip", "nightly", "certify-reported")));
  });
});

test("a green or cancelled nightly opens nothing", async () => {
  for (const conclusion of ["success", "cancelled"]) {
    const dir = mkdtempSync(path.join(tmpdir(), "staple-certify-green-"));
    try {
      writeFileSync(path.join(dir, "actions_workflows_staple_certify_yml_runs_branch_master_status_completed_per_page_1.json"),
        JSON.stringify({ workflow_runs: [{ id: 7, head_sha: sha("m1"), conclusion }] }));
      const result = spawnSync("bash", [script, "certify-report"], { encoding: "utf8", env: {
        ...process.env, HOME: dir, STAPLE_GITHUB_FIXTURES: dir, STAPLE_API: "http://127.0.0.1:9",
      } });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`run 7 on m1000000 is ${conclusion}; no repair needed`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

/** Runs the 02:30 `hold` mode against a fake Staple API on `installed`; records hold requests. */
async function holdRun({ installed, chain, statuses = {} }) {
  const holds = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const send = (value, code = 200) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value)); };
      if (req.method === "GET" && req.url === "/api/health") return send({ commit: installed ? sha(installed) : "" });
      if (req.method === "POST" && req.url === "/api/instance/maintenance-hold") {
        holds.push(JSON.parse(body));
        return send({ hold: { startedAt: "s", drainDeadlineAt: "d", expiresAt: "e" }, queuedRuns: 0, runningRuns: 0 }, 201);
      }
      send({ error: "not found" }, 404);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const home = mkdtempSync(path.join(tmpdir(), "staple-hold-home-"));
  const fixtures = path.join(home, "fixtures");
  mkdirSync(path.join(home, ".paperclip"));
  mkdirSync(fixtures);
  writeFileSync(path.join(home, ".paperclip", "auth.json"), JSON.stringify({ token: "staple-test-token" }));
  if (chain) writeFileSync(path.join(fixtures, "chain"), chain.map(sha).join("\n") + "\n");
  for (const [name, list] of Object.entries(statuses)) {
    writeFileSync(path.join(fixtures, `statuses-${sha(name)}.json`), JSON.stringify(list));
  }
  try {
    const { stdout } = await promisify(execFile)("bash", [script, "hold"], { env: {
      ...process.env, HOME: home, STAPLE_GITHUB_FIXTURES: fixtures, STAPLE_API: `http://127.0.0.1:${server.address().port}`,
      NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1",
    } });
    return { out: stdout, holds };
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
}

test("the 02:30 hold is not placed when nothing newer than the installed build is certified", async () => {
  // Red nightly on m2, installed m1: the 03:30 run would skip, so holding would only park work.
  const red = await holdRun({ installed: "m1", chain: ["m2", "m1"], statuses: { m2: [status("failure")] } });
  assert.match(red.out, /no certified commit to install \(installed-newest\); not placing the hold/);
  assert.deepEqual(red.holds, []);
  const unreadable = await holdRun({ installed: "m1" });
  assert.match(unreadable.out, /not placing the hold/);
  assert.deepEqual(unreadable.holds, []);
});

test("the 02:30 hold is placed when a newer certified commit is waiting", async () => {
  const { out, holds } = await holdRun({ installed: "m1", chain: ["m3", "m2", "m1"], statuses: { m3: [status("failure")], m2: [status("success")] } });
  assert.match(out, /certified target: target:m2/);
  assert.equal(holds.length, 1);
  assert.equal(holds[0].reason, "nightly maintenance window");
});

// Gate 2 (STA-223): `paperclipai db:backup --json` prints its banner and progress, the metadata as
// pretty-printed JSON, then an outro, all on stdout. Reading only the last line found nothing, so a
// good backup was reported as failed and the certified upgrade stopped at the backup gate.
const esc = (code, text) => `\x1b[${code}m${text}\x1b[39m`;
function dbBackupStdout(meta) {
  return [
    "", esc(36, "██████╗  █████╗ ██████╗ ███████╗██████╗  ██████╗██╗     ██╗██████╗ "),
    esc(34, "  ───────────────────────────────────────────────────────"), "",
    `┌   ${esc(46, " paperclip db:backup ")}`, "│", `│  ${esc(2, "Config: /home/u/.paperclip/instances/default/config.json")}`,
    `│  ${esc(2, "Connection source: embedded-postgres@54329 {pid 4242}")}`, "│",
    "◒  Creating database backup...", `◇  Backup saved: ${meta?.backupFile} (907.9 MB)`, "│",
    ...(meta === undefined ? [] : [JSON.stringify(meta, null, 2)]),
    "│", `└  ${esc(32, "Backup completed.")}`, "", "",
  ].join("\n");
}

/** Saves db:backup stdout (and optionally a backup file) and asks the installer for the Gate 2 result. */
function backupResult({ stdout, rc = 0, bytes, meta = (file) => ({ backupFile: file, sizeBytes: 12, prunedCount: 0 }) }) {
  const dir = mkdtempSync(path.join(tmpdir(), "staple-backup-"));
  try {
    const file = path.join(dir, "staple-nightly-pre-6143ccf8-20261112-215518.sql.gz");
    if (bytes !== undefined) writeFileSync(file, Buffer.alloc(bytes, 1));
    writeFileSync(path.join(dir, "out"), stdout ?? dbBackupStdout(meta(file)));
    const result = spawnSync("bash", [script, "backup-result", path.join(dir, "out"), String(rc)], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().replace(dir, "<dir>");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("Gate 2 reads backupFile from the real db:backup output, not its last line", () => {
  const stdout = dbBackupStdout({ backupFile: "/b/x.sql.gz", sizeBytes: 12 });
  // The old gate: `tail -1` of this output, grepped for "path or "file, never matched.
  assert.doesNotMatch(stdout.trimEnd().split("\n").at(-1), /"path|"file/);
  assert.equal(backupResult({ bytes: 12 }), "file:<dir>/staple-nightly-pre-6143ccf8-20261112-215518.sql.gz");
});

test("Gate 2 accepts compact metadata and a backup without a reported size", () => {
  assert.match(backupResult({ bytes: 5, stdout: undefined, meta: (file) => ({ backupFile: file }) }), /^file:/);
  const dir = mkdtempSync(path.join(tmpdir(), "staple-backup-"));
  try {
    const file = path.join(dir, "b.sql.gz"); writeFileSync(file, "x");
    assert.match(backupResult({ stdout: `noise {not json}\n${JSON.stringify({ backupFile: file, sizeBytes: 1 })}\n` }), /^file:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Gate 2 fails closed on a nonzero exit even when the metadata looks good", () => {
  assert.equal(backupResult({ bytes: 12, rc: 1 }), "error:db:backup exited 1");
});

test("Gate 2 fails closed without readable metadata", () => {
  assert.equal(backupResult({ bytes: 12, stdout: "" }), "error:no backup metadata in db:backup output");
  assert.equal(backupResult({ bytes: 12, stdout: dbBackupStdout(undefined) }), "error:no backup metadata in db:backup output");
  // Truncated JSON: the output stopped mid-object.
  assert.equal(backupResult({ bytes: 12, stdout: '{\n  "backupFile": "/b/x.sql.gz",\n  "sizeBytes": 1' }),
    "error:no backup metadata in db:backup output");
  assert.equal(backupResult({ bytes: 12, meta: () => ({ backupFile: "relative/x.sql.gz" }) }),
    "error:backupFile is not an absolute path ('relative/x.sql.gz')");
  assert.equal(backupResult({ bytes: 12, meta: () => ({ backupFile: null }) }), "error:backupFile is not an absolute path (None)");
});

test("Gate 2 fails closed when the named backup file is missing, empty or the wrong size", () => {
  assert.equal(backupResult({}), "error:backup file missing (<dir>/staple-nightly-pre-6143ccf8-20261112-215518.sql.gz)");
  assert.equal(backupResult({ bytes: 0, meta: (file) => ({ backupFile: file }) }),
    "error:backup file empty (<dir>/staple-nightly-pre-6143ccf8-20261112-215518.sql.gz)");
  assert.equal(backupResult({ bytes: 7 }),
    "error:backup file is 7 bytes, db:backup reported 12 (<dir>/staple-nightly-pre-6143ccf8-20261112-215518.sql.gz)");
});

function startupLogged(journal, since = "2026-11-13 00:09:45") {
  const dir = mkdtempSync(path.join(tmpdir(), "staple-journal-"));
  try {
    const lines = Array.from({ length: 20000 }, (_, i) => `Nov 13 00:09:${String(i % 60).padStart(2, "0")} host paperclipai[1]: request ${i} served`).join("\n");
    const marker = "Nov 13 00:09:57 host paperclipai[1]: Server startup recovery complete";
    const bodies = {
      early: `${marker}\n${lines}\n`,
      late: `${lines}\n${marker}\n`,
      missing: `${lines}\n`,
      empty: "",
    };
    writeFileSync(path.join(dir, "journal"), bodies[journal.body] ?? "");
    writeFileSync(path.join(dir, "journalctl"), [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$@" > "${path.join(dir, "args")}"`,
      journal.fail
        ? `cat "${path.join(dir, "journal")}"; echo "Failed to open journal: Permission denied" >&2; exit ${journal.fail}`
        : `exec cat "${path.join(dir, "journal")}"`,
      "",
    ].join("\n"), { mode: 0o755 });
    const { BASH_ENV, ...inherited } = process.env;
    const env = { ...inherited, PATH: `${dir}:${process.env.PATH}` };
    const result = spawnSync("bash", [script, "startup-logged", since], { encoding: "utf8", env });
    const args = readFileSync(path.join(dir, "args"), "utf8").trim().split("\n");
    const old = spawnSync("bash", ["-o", "pipefail", "-c",
      'journalctl --user -u paperclipai --since "-6min" --no-pager | grep -q "startup recovery complete"; echo "$? ${PIPESTATUS[*]}"'],
    { encoding: "utf8", env });
    return { out: result.stdout.trim(), status: result.status, args, old: old.stdout.trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("Gate 3 sees startup recovery logged early in a large journal", () => {
  const result = startupLogged({ body: "early" });
  assert.match(result.old, /^141 /);
  assert.deepEqual([result.out, result.status], ["logged", 0]);
  assert.deepEqual(result.args, ["--user", "-u", "paperclipai", "--since", "2026-11-13 00:09:45", "--no-pager"]);
  assert.deepEqual([startupLogged({ body: "late" }).out, startupLogged({ body: "late" }).status], ["logged", 0]);
});

test("Gate 3 keeps waiting while the marker is not in the journal", () => {
  assert.deepEqual(Object.values((({ out, status }) => ({ out, status }))(startupLogged({ body: "missing" }))), ["waiting", 1]);
  assert.deepEqual(Object.values((({ out, status }) => ({ out, status }))(startupLogged({ body: "empty" }))), ["waiting", 1]);
});

test("Gate 3 fails closed when journalctl fails, even after printing the marker", () => {
  for (const body of ["missing", "early"]) {
    const result = startupLogged({ body, fail: 1 });
    assert.equal(result.status, 2);
    assert.equal(result.out, "error:journalctl exited 1 (Failed to open journal: Permission denied)");
  }
});

test("an unknown argument exits before any upgrade step instead of running the upgrade", () => {
  const home = mkdtempSync(path.join(tmpdir(), "staple-home-"));
  try {
    const { BASH_ENV, ...inherited } = process.env;
    const result = spawnSync("bash", [script, "startup-loged", "x"], {
      encoding: "utf8", env: { ...inherited, HOME: home, STAPLE_API: "http://127.0.0.1:9" },
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown argument: startup-loged/);
    assert.equal(spawnSync("ls", ["-A", home], { encoding: "utf8" }).stdout, "");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
