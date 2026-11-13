import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import test from "node:test";

import {
  classify,
  evaluate,
  firstParentRange,
  followUpCard,
  inInstallerWindow,
  lastNightly,
  linkedIssueIds,
  updateComment,
  verdictOf,
  zonedTime,
} from "../staple/staple-missed-upgrade.mjs";

// STA-225: a missed nightly upgrade, or a merged change uninstalled for two hours, gets one report on the
// upgrade-log issue and, only for a Critical or day-costly Valuable change, one Upgrade now / Wait for
// tonight card. The e2e cases run the CLI against a fake GitHub and Staple, with the real installer
// script providing the certified pick and the Gate 0 verdict.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = path.join(repoRoot, "scripts", "staple", "staple-missed-upgrade.mjs");
const installer = path.join(repoRoot, "scripts", "staple", "staple-nightly-upgrade.sh");
const TZ = "America/Denver";

const sha = (c) => c.repeat(40);
const I0 = sha("a"); // installed
const M1 = sha("b"); // PR #33 Console navigation (STA-213)
const M2 = sha("c"); // PR #29 pause fix (STA-197)
const M3 = sha("d"); // PR #41 merged after the certified commit

// Paperclip issues as they were on Nov 9 (priorities read from Staple).
const ISSUES = {
  "STA-197": { identifier: "STA-197", title: "CRITICAL: 7 agents stuck in lifecycle 'pausing', resume is a no-op", priority: "critical", status: "in_progress", blocks: [] },
  "STA-213": { identifier: "STA-213", title: "Staple Console: add Console to the sidebar nav (FAC-620)", priority: "high", status: "done", blocks: [] },
  "STA-223": { identifier: "STA-223", title: "Staple CI: change-scoped PR checks", priority: "high", status: "in_review", blocks: [{ identifier: "STA-324", status: "todo" }] },
  "STA-182": { identifier: "STA-182", title: "FAC-840 C1: enforce Staple service lifecycle authority", priority: "high", status: "in_progress", blocks: [{ identifier: "STA-184", status: "in_progress" }] },
};
const PRS = {
  33: { title: "feat(staple-console): add Console to the sidebar and phone bottom bar (STA-213)", head: "sta-213-console-sidebar-nav", merged: "2026-11-09T21:35:34Z" },
  29: { title: "fix(lifecycle): let a pause complete behind a settled pre-dispatch Stop (STA-197)", head: "sta-197-pause-stop-proof", merged: "2026-11-10T11:40:53Z" },
  41: { title: "ci(staple): change-scoped PR checks, nightly certification, install only certified commits (STA-223)", head: "sta-223-change-scoped-ci", merged: "2026-11-10T15:31:19Z" },
};
const issueMap = () => new Map(Object.entries(ISSUES));

function change(s, pr) {
  const p = PRS[pr];
  return { sha: s, pr, title: p.title, mergedAt: p.merged, linked: linkedIssueIds({ title: p.title, headRef: p.head }), upstream: null };
}

function classified(...changes) {
  const issues = issueMap();
  return changes.map((c) => ({ ...c, ...classify(c, issues) }));
}

function inputs(over = {}) {
  return {
    now: new Date("2026-11-10T14:00:00Z"), // 07:00 MST
    timeZone: TZ,
    installed: I0,
    master: M2,
    pick: `target:${M2} installed-in-chain:yes`,
    gate0: "green",
    changes: classified(change(M1, 33), change(M2, 29)),
    targetAhead: true,
    certifiedAt: "2026-11-10T12:30:00Z",
    masterCert: "success",
    nightlyLog: { file: "upgrade-20261110-0330.log", date: "2026-11-10", reports: ["Skipped: no staple/certified commit in the last 40 master commits"] },
    runningRuns: 3,
    ...over,
  };
}

test("Nov 9 replay: the pause fix is Critical, Console navigation is not, and only the pause fix is on the card", () => {
  const [nav, pause] = classified(change(M1, 33), change(M2, 29));
  assert.equal(pause.cls, "Critical");
  assert.match(pause.why[0], /STA-197 is critical: CRITICAL: 7 agents stuck/);
  assert.ok(["Valuable", "Can wait"].includes(nav.cls));
  assert.equal(nav.dayCostly, false);

  const d = evaluate(inputs());
  assert.equal(d.kind, "report");
  assert.equal(d.key, `${I0}:${M2}`);
  assert.match(d.body, /PR #33 has been merged and uninstalled for 16 h 24 min/);
  assert.match(d.body, /\*\*Recommendation:\*\* Upgrade now to cccccccc: 1 change below cannot wait/);
  assert.match(d.body, /- \*\*Critical\*\*: PR #29 fix\(lifecycle\)/);
  assert.match(d.body, /- \*\*Valuable\*\*: PR #33 feat\(staple-console\)/);
  assert.ok(d.card);
  assert.equal(d.card.kind, "request_confirmation");
  assert.equal(d.card.payload.acceptLabel, "Upgrade now");
  assert.equal(d.card.payload.rejectLabel, "Wait for tonight");
  assert.equal(d.card.resolverPolicy, "human_only");
  assert.equal(d.card.idempotencyKey, `staple-missed-upgrade:card:${I0}:${M2}`);
  const details = d.card.payload.detailsMarkdown;
  assert.match(details, new RegExp(`Chosen commit: \`${M2}\``));
  assert.match(details, /PR #29/);
  assert.doesNotMatch(details, /PR #33/);
  assert.match(details, /drain of up to 10 minutes, then about 10 minutes/);
  assert.match(details, /3 runs are running now/);
});

test("Valuable changes cost a day only while their defect still blocks open work; CI changes can wait", () => {
  const issues = issueMap();
  const lifecycle = classify({ title: "feat(lifecycle): maintenance hold (STA-182)", linked: ["STA-182"] }, issues);
  assert.deepEqual([lifecycle.cls, lifecycle.dayCostly], ["Valuable", true]);
  assert.match(lifecycle.why[0], /STA-182 still blocks open work \(STA-184\)/);
  assert.equal(classify({ title: PRS[41].title, linked: ["STA-223"] }, issues).cls, "Can wait");
  assert.equal(classify({ title: "Staple upstream sync 2026-11-10", linked: [] }, issues).cls, "Can wait");
  assert.equal(classify({ title: "fix(ci): something", linked: ["STA-197"] }, issues).cls, "Critical");

  const nav = change(M1, 33);
  const d = evaluate(inputs({ master: M1, pick: `target:${M1} installed-in-chain:yes`, changes: classified(nav) }));
  assert.equal(d.kind, "report");
  assert.equal(d.card, null);
  assert.match(d.body, /\*\*Recommendation:\*\* Wait for tonight: nothing below is Critical or costs a day/);

  // A Critical fix merged after the certified commit is named, with the certification it needs.
  const later = evaluate(inputs({ pick: `target:${M1} installed-in-chain:yes` }));
  assert.equal(later.card, null);
  assert.match(later.body, /PR #29, merged after it, is Critical but not certified yet: dispatch `staple-certify.yml`/);
  assert.match(later.body, /\*\*Merged after `bbbbbbbb`, not certified yet:\*\*\n- \*\*Critical\*\*: PR #29/);
});

test("a pending Gate 0 is a CI wait: no report and no card, however long it has been", () => {
  for (const gate0 of ["pending:merge-and-push", "pending:workflow Docker; merge-and-push"]) {
    const d = evaluate(inputs({ gate0, now: new Date("2026-11-10T22:00:00Z") }));
    assert.equal(d.kind, "silent");
    assert.match(d.reason, /^pending, retry: master cccccccc CI still running/);
  }
  assert.equal(evaluate(inputs({ gate0: "error:check-runs unreadable" })).kind, "silent");
  assert.equal(evaluate(inputs({ pick: "installed-newest", masterCert: "pending" })).kind, "silent");
  assert.equal(evaluate(inputs({ pick: "installed-newest", masterCert: "unreadable" })).kind, "silent");
});

test("a completed red build is reported as a failure and its commit is not recommended", () => {
  const d = evaluate(inputs({ gate0: "red:merge-and-push (failure)" }));
  assert.equal(d.kind, "report");
  assert.equal(d.card, null);
  assert.match(d.body, /Gate 0 CI: `red:merge-and-push \(failure\)`/);
  assert.match(d.body, /\*\*Recommendation:\*\* No upgrade available: Gate 0 blocks cccccccc because its CI is not green/);
  assert.doesNotMatch(d.body, /Upgrade now/);
});

test("triggers: a missed nightly run, two hours uninstalled, and silence inside the cycle", () => {
  // Certified at 22:50 MST, still not installed after the 03:30 run: a missed nightly even for a fresh merge.
  const fresh = { ...change(M2, 29), mergedAt: "2026-11-10T05:30:00Z" };
  const missed = evaluate(inputs({ changes: classified(fresh), master: M2, certifiedAt: "2026-11-10T05:50:00Z", now: new Date("2026-11-10T12:00:00Z") }));
  assert.equal(missed.kind, "report");
  assert.match(missed.body, /the 2026-11-10 03:30 nightly run did not install cccccccc, certified before it/);
  assert.match(missed.body, /Nightly log `upgrade-20261110-0330.log`: `Skipped: no staple\/certified commit/);

  const noLog = evaluate(inputs({ nightlyLog: null }));
  assert.match(noLog.body, /No nightly upgrade log for 2026-11-10: the 03:30 run did not start/);

  // Merged 90 minutes ago and certified by a dispatch after the nightly run: not yet due.
  const recent = { ...change(M2, 29), mergedAt: "2026-11-10T12:30:00Z" };
  const early = evaluate(inputs({ changes: classified(recent), certifiedAt: "2026-11-10T13:30:00Z" }));
  assert.equal(early.kind, "silent");
  assert.equal(evaluate(inputs({ changes: classified(recent), certifiedAt: "2026-11-10T13:30:00Z", now: new Date("2026-11-10T14:31:00Z") })).kind, "report");

  // The installer owns 02:15-04:30 local.
  assert.equal(evaluate(inputs({ now: new Date("2026-11-10T10:00:00Z") })).kind, "silent");
});

test("no newer certified commit: wait for tonight, or certify now for a Critical change; never a card", () => {
  const wait = evaluate(inputs({ pick: "installed-newest", masterCert: null, changes: classified(change(M1, 33)), master: M1 }));
  assert.equal(wait.kind, "report");
  assert.equal(wait.card, null);
  assert.equal(wait.key, `${I0}:uncertified:`);
  assert.match(wait.body, /Wait for tonight: the 22:45 certification and the 03:30 run install these changes/);

  const crit = evaluate(inputs({ pick: "installed-newest", masterCert: "failure" }));
  assert.equal(crit.card, null);
  assert.equal(crit.key, `${I0}:uncertified:29`);
  assert.match(crit.body, /Certify master now: PR #29 is Critical/);
  assert.match(crit.body, /master `cccccccc` certification: `failure`/);
});

test("card follow-up: one answer comment, and a pending card is withdrawn once Staple moved", () => {
  const entry = { key: `${I0}:${M2}`, installed: I0, target: M2 };
  const yes = followUpCard(entry, { status: "accepted" }, I0);
  assert.equal(yes.closed, true);
  assert.match(yes.comment, /Upgrade now chosen.*qualified operator.*does not install or restart/s);
  const no = followUpCard(entry, { status: "rejected" }, I0);
  assert.match(no.comment, /Wait for tonight chosen.*No new card/s);
  assert.deepEqual(followUpCard(entry, { status: "pending" }, I0), { comment: null, closed: false, withdraw: false });
  assert.deepEqual(followUpCard(entry, { status: "pending" }, M2), { comment: null, closed: true, withdraw: true });
  // An Upgrade now answer read after Staple already moved records the answer without a stale handoff.
  const moved = followUpCard(entry, { status: "accepted" }, M2);
  assert.equal(moved.closed, true);
  assert.match(moved.comment, new RegExp(`^<!-- staple-missed-upgrade:answer:${I0}:${M2} -->`));
  assert.match(moved.comment, /Staple has moved from `aaaaaaaa` to `cccccccc`.*No handoff/s);
  assert.doesNotMatch(moved.comment, /HOLD_DRAIN_MIN/);
});

test("each report carries its verdict, and an update replaces it with one marked comment", () => {
  const red = evaluate(inputs({ gate0: "red:merge-and-push (failure)" }));
  const green = evaluate(inputs());
  assert.deepEqual([red.verdict, verdictOf(red.body)], ["red", "red"]);
  assert.deepEqual([green.verdict, verdictOf(green.body)], ["upgrade", "upgrade"]);
  assert.equal(evaluate(inputs({ master: M1, pick: `target:${M1} installed-in-chain:yes`, changes: classified(change(M1, 33)) })).verdict, "wait");
  assert.equal(evaluate(inputs({ pick: "installed-newest", masterCert: "failure" })).verdict, "certify");
  const u = updateComment(green, "red");
  assert.match(u, new RegExp(`^<!-- staple-missed-upgrade:update:${I0}:${M2}:upgrade -->\n\\*\\*Update: Missed upgrade`));
  assert.match(u, /replacing "No upgrade available"/);
  assert.equal(u.match(/<!-- staple-missed-upgrade:/g).length, 1);
  assert.equal(verdictOf(u), "upgrade");
});

test("history helpers: first-parent range, linked issues, time zone", () => {
  const commits = [
    { sha: "u1", parents: [{ sha: "x" }] },
    { sha: M1, parents: [{ sha: I0 }, { sha: "u1" }] },
    { sha: M2, parents: [{ sha: M1 }, { sha: "u2" }] },
  ];
  assert.deepEqual(firstParentRange(commits, I0, M2).map((c) => c.sha), [M1, M2]);
  assert.equal(firstParentRange(commits, sha("e"), M2), null);
  assert.deepEqual(linkedIssueIds({ title: "Staple upstream sync", headRef: "staple/upstream-sync", body: "Coordinate with STA-184.\nCloses STA-323" }), ["STA-323"]);
  assert.deepEqual(linkedIssueIds({ title: "fix: x (STA-197)", headRef: "sta-197-pause", body: "Closes STA-1" }), ["STA-197"]);
  assert.equal(zonedTime(2026, 11, 10, 3, 30, TZ).toISOString(), "2026-11-10T10:30:00.000Z");
  assert.equal(zonedTime(2026, 7, 10, 3, 30, TZ).toISOString(), "2026-07-10T09:30:00.000Z");
  assert.equal(lastNightly(new Date("2026-11-10T10:00:00Z"), TZ).at.toISOString(), "2026-11-09T10:30:00.000Z");
  assert.equal(lastNightly(new Date("2026-11-10T11:00:00Z"), TZ).finished, false);
  assert.equal(inInstallerWindow(new Date("2026-11-10T11:29:00Z"), TZ), true);
  assert.equal(inInstallerWindow(new Date("2026-11-10T11:30:00Z"), TZ), false);
});

// --- end to end -----------------------------------------------------------------------------------

function fakeWorld() {
  const w = {
    installed: I0,
    master: M2,
    gate0: { checks: [{ name: "verify", status: "completed", conclusion: "success" }], runs: [{ name: "PR", status: "completed", conclusion: "success" }] },
    certifiedAt: "2026-11-10T12:30:00Z",
    comments: [],
    interactions: [],
    running: 1,
  };
  const commits = [
    { sha: M1, parents: [{ sha: I0 }], commit: { message: "Merge pull request #33 from ethanmonlux/sta-213-console-sidebar-nav", committer: { date: PRS[33].merged } } },
    { sha: M2, parents: [{ sha: M1 }], commit: { message: "Merge pull request #29 from ethanmonlux/sta-197-pause-stop-proof", committer: { date: PRS[29].merged } } },
  ];
  const routes = (url, method, body) => {
    const p = url.pathname;
    const gh = /^\/gh\/repos\/[^/]+\/[^/]+\/(.*)$/.exec(p)?.[1];
    if (gh !== undefined) {
      if (gh === "commits/master") return { sha: w.master };
      if (gh.startsWith("compare/")) {
        const to = gh.split("...")[1];
        const upto = commits.slice(0, commits.findIndex((c) => c.sha === to) + 1);
        const page = Number(url.searchParams.get("page") || 1);
        return { status: "ahead", total_commits: upto.length, commits: page === 1 ? upto : [] };
      }
      const pr = /^pulls\/(\d+)$/.exec(gh)?.[1];
      if (pr) return { title: PRS[pr].title, head: { ref: PRS[pr].head }, body: "", merged_at: PRS[pr].merged };
      if (gh === `commits/${M2}/statuses`) return [{ context: "staple/certified", state: "success", created_at: w.certifiedAt }];
      if (/^commits\/\w+\/statuses$/.test(gh)) return [];
      if (/^commits\/\w+\/check-runs$/.test(gh)) return { total_count: w.gate0.checks.length, check_runs: w.gate0.checks };
      if (gh === "actions/runs") return { total_count: w.gate0.runs.length, workflow_runs: w.gate0.runs };
      if (gh.startsWith("actions/workflows/")) return { workflow_runs: [] };
      return null;
    }
    if (p === "/api/health") return { commit: w.installed };
    if (p === "/api/issues/log/comments") {
      if (method === "POST") { const c = { id: `c${w.comments.length + 1}`, body: body.body }; w.comments.push(c); return c; }
      // As the comments route: newest first unless order=asc, limit capped at 500, `after` a comment id cursor.
      const asc = url.searchParams.get("order") === "asc";
      let list = asc ? [...w.comments] : [...w.comments].reverse();
      const after = url.searchParams.get("after");
      if (after) { const at = list.findIndex((c) => c.id === after); list = at < 0 ? [] : list.slice(at + 1); }
      const limit = Number(url.searchParams.get("limit"));
      return limit > 0 ? list.slice(0, Math.min(limit, 500)) : list;
    }
    if (p === "/api/issues/log/interactions") {
      if (method === "POST") {
        // As Staple: the same key returns the existing card only for an equivalent request, else 409.
        const prior = w.interactions.find((i) => i.idempotencyKey === body.idempotencyKey);
        if (prior && !isDeepStrictEqual(prior.request, body)) return { status: 409, body: { error: "Interaction idempotency key already exists for a different request" } };
        if (prior) return prior;
        const i = { id: `i${w.interactions.length + 1}`, status: "pending", ...body, request: body };
        w.interactions.push(i); return i;
      }
      return w.interactions;
    }
    const wd = /^\/api\/issues\/log\/interactions\/(\w+)\/withdraw$/.exec(p)?.[1];
    if (wd) { const i = w.interactions.find((x) => x.id === wd); i.status = "cancelled"; return i; }
    const issue = /^\/api\/issues\/(STA-\d+)$/.exec(p)?.[1];
    if (issue) return ISSUES[issue] ?? null;
    if (/heartbeat-runs$/.test(p)) return Array.from({ length: w.running }, () => ({ status: "running" }));
    return null;
  };
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (d) => { data += d; });
    req.on("end", () => {
      let out = routes(new URL(req.url, "http://x"), req.method, data ? JSON.parse(data) : null);
      let status = out === null ? 404 : 200;
      if (out?.status === 409) ({ status, body: out } = out);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out ?? { message: "Not Found" }));
    });
  });
  return { w, server };
}

async function withWorld(fn) {
  const { w, server } = fakeWorld();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const dir = mkdtempSync(path.join(tmpdir(), "staple-missed-test-"));
  const nightly = path.join(dir, "nightly"); const fixtures = path.join(dir, "fixtures");
  mkdirSync(nightly); mkdirSync(fixtures);
  writeFileSync(path.join(fixtures, "chain"), `${M2}\n${M1}\n${I0}\n`);
  writeFileSync(path.join(fixtures, `statuses-${M2}.json`), JSON.stringify([{ context: "staple/certified", state: "success" }]));
  const run = (now, args = []) => new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: {
        ...process.env, HOME: dir, STAPLE_API: `http://127.0.0.1:${port}`, STAPLE_GITHUB_API: `http://127.0.0.1:${port}/gh`,
        STAPLE_GITHUB_FIXTURES: fixtures, STAPLE_UPGRADE_BIN: installer, STAPLE_NIGHTLY_DIR: nightly, STAPLE_REPORT_ISSUE: "log",
        STAPLE_BOARD_TOKEN: "test", STAPLE_NOW: now, STAPLE_TZ: TZ, STAPLE_GITHUB_TOKEN: "",
        NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
      },
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => resolve({ code, out }));
  });
  try { await fn({ w, run, nightly }); }
  finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
}

test("e2e: a required job running at two hourly checks, then succeeding and installing, never reports", async () => {
  await withWorld(async ({ w, run }) => {
    w.gate0.checks = [{ name: "merge-and-push", status: "in_progress", conclusion: null }];
    for (const now of ["2026-11-10T14:00:00Z", "2026-11-10T15:00:00Z"]) {
      const r = await run(now);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /no report: pending, retry: master cccccccc CI still running \(merge-and-push\)/);
    }
    w.gate0.checks = [{ name: "merge-and-push", status: "completed", conclusion: "success" }];
    w.installed = M2; // the next watcher check installed it
    const r = await run("2026-11-10T16:00:00Z");
    assert.match(r.out, /no report: installed is master/);
    assert.equal(w.comments.length, 0);
    assert.equal(w.interactions.length, 0);
  });
});

test("e2e: one report and one card per pair across hourly checks and a lost state file; the answer is followed up once", async () => {
  await withWorld(async ({ w, run, nightly }) => {
    let r = await run("2026-11-10T14:00:00Z");
    assert.equal(r.code, 0, r.out);
    assert.equal(w.comments.length, 1);
    assert.match(w.comments[0].body, /^\*\*Missed upgrade: cccccccc not installed \(installed aaaaaaaa\)\*\*/);
    assert.match(w.comments[0].body, new RegExp(`<!-- staple-missed-upgrade:${I0}:${M2} -->`));
    assert.equal(w.interactions.length, 1);
    assert.match(w.interactions[0].payload.detailsMarkdown, /1 run is running now/);

    r = await run("2026-11-10T15:00:00Z");
    assert.match(r.out, /already reported/);
    rmSync(path.join(nightly, "missed-upgrade-state.json")); // a restart that lost the state
    r = await run("2026-11-10T16:00:00Z");
    assert.match(r.out, /already reported .* \(comment c1\)/);
    assert.equal(w.comments.length, 1);
    assert.equal(w.interactions.length, 1);

    w.interactions[0].status = "accepted";
    await run("2026-11-10T17:00:00Z");
    await run("2026-11-10T18:00:00Z");
    assert.equal(w.comments.length, 2);
    assert.match(w.comments[1].body, /Upgrade now chosen.*HOLD_DRAIN_MIN=10/s);
    assert.equal(JSON.parse(readFileSync(path.join(nightly, "missed-upgrade-state.json"), "utf8")).reports[`${I0}:${M2}`].cardClosed, "accepted");
  });
});

test("e2e: Wait for tonight is recorded once, and a card left pending is withdrawn after the install", async () => {
  await withWorld(async ({ w, run }) => {
    await run("2026-11-10T14:00:00Z");
    w.interactions[0].status = "rejected";
    await run("2026-11-10T15:00:00Z");
    await run("2026-11-10T16:00:00Z");
    assert.equal(w.comments.length, 2);
    assert.match(w.comments[1].body, /Wait for tonight chosen/);
  });
  await withWorld(async ({ w, run }) => {
    await run("2026-11-10T14:00:00Z");
    w.installed = M2;
    await run("2026-11-11T11:30:00Z");
    assert.equal(w.interactions[0].status, "cancelled");
    assert.equal(w.comments.length, 1);
  });
});

test("e2e: a red build reports the failure with no card; --dry-run writes nothing", async () => {
  await withWorld(async ({ w, run }) => {
    const dry = await run("2026-11-10T14:00:00Z", ["--dry-run"]);
    assert.match(dry.out, /DRY RUN: would report/);
    assert.match(dry.out, /DRY RUN: would raise the card/);
    assert.equal(w.comments.length + w.interactions.length, 0);

    w.gate0.checks = [{ name: "merge-and-push", status: "completed", conclusion: "failure" }];
    const r = await run("2026-11-10T14:00:00Z");
    assert.equal(r.code, 0, r.out);
    assert.equal(w.comments.length, 1);
    assert.match(w.comments[0].body, /Gate 0 CI: `red:merge-and-push \(failure\)`/);
    assert.match(w.comments[0].body, /No upgrade available/);
    assert.equal(w.interactions.length, 0);
    assert.equal((await run("2026-11-10T14:00:00Z", ["--bogus"])).code, 2);
  });
});

const STATE = "missed-upgrade-state.json";
const reports = (w) => w.comments.filter((c) => c.body.includes(`<!-- staple-missed-upgrade:${I0}:${M2} -->`));
const answers = (w) => w.comments.filter((c) => c.body.includes(`<!-- staple-missed-upgrade:answer:${I0}:${M2} -->`));

test("e2e: a lost state file never strands a card: it is withdrawn after the install, or its answer followed up once", async () => {
  await withWorld(async ({ w, run, nightly }) => {
    await run("2026-11-10T14:00:00Z");
    rmSync(path.join(nightly, STATE));
    w.installed = M2;
    const r = await run("2026-11-10T15:00:00Z");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /no report: installed is master/);
    assert.equal(w.interactions[0].status, "cancelled");
  });
  await withWorld(async ({ w, run, nightly }) => {
    await run("2026-11-10T14:00:00Z");
    rmSync(path.join(nightly, STATE));
    w.interactions[0].status = "accepted";
    await run("2026-11-10T15:00:00Z");
    assert.equal(answers(w).length, 1);
    assert.match(answers(w)[0].body, /HOLD_DRAIN_MIN=10/);
    rmSync(path.join(nightly, STATE));
    const r = await run("2026-11-10T16:00:00Z");
    assert.match(r.out, /answer for .* already posted/);
    assert.equal(answers(w).length, 1);
    assert.equal(reports(w).length, 1);
  });
  // Answered, then the build moved before any check saw it, with the state lost too.
  await withWorld(async ({ w, run, nightly }) => {
    await run("2026-11-10T14:00:00Z");
    rmSync(path.join(nightly, STATE));
    w.interactions[0].status = "rejected";
    w.installed = M2;
    await run("2026-11-10T15:00:00Z");
    assert.equal(answers(w).length, 1);
    assert.match(answers(w)[0].body, /Wait for tonight chosen/);
  });
});

test("e2e: an answer posted before its checkpoint was lost is not posted again", async () => {
  await withWorld(async ({ w, run, nightly }) => {
    await run("2026-11-10T14:00:00Z");
    const before = readFileSync(path.join(nightly, STATE));
    w.interactions[0].status = "accepted";
    await run("2026-11-10T15:00:00Z");
    writeFileSync(path.join(nightly, STATE), before); // the cardClosed checkpoint never reached the disk
    await run("2026-11-10T16:00:00Z");
    assert.equal(answers(w).length, 1);
    assert.equal(JSON.parse(readFileSync(path.join(nightly, STATE), "utf8")).reports[`${I0}:${M2}`].cardClosed, "accepted");
  });
});

test("e2e: a report marker beyond the first comment pages is still found after a lost state file", async () => {
  await withWorld(async ({ w, run, nightly }) => {
    for (let i = 0; i < 1200; i++) w.comments.push({ id: `old${i}`, body: "earlier upgrade-log entry" });
    await run("2026-11-10T14:00:00Z");
    assert.equal(reports(w).length, 1);
    for (let i = 0; i < 600; i++) w.comments.push({ id: `new${i}`, body: "later upgrade-log entry" });
    rmSync(path.join(nightly, STATE));
    const r = await run("2026-11-10T15:00:00Z");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /already reported .* \(comment c1201\)/);
    assert.equal(reports(w).length, 1);
    assert.equal(w.interactions.length, 1);
  });
});

test("e2e: a card created before its cardId checkpoint is adopted, not replayed into a 409", async () => {
  await withWorld(async ({ w, run, nightly }) => {
    await run("2026-11-10T14:00:00Z");
    const file = path.join(nightly, STATE);
    const st = JSON.parse(readFileSync(file, "utf8"));
    st.reports[`${I0}:${M2}`].cardId = null; // the POST succeeded, its checkpoint did not
    writeFileSync(file, JSON.stringify(st));
    w.running = 2; // the details now differ, so a replay under the same key would get a 409
    for (const now of ["2026-11-10T15:00:00Z", "2026-11-10T16:00:00Z"]) {
      const r = await run(now);
      assert.equal(r.code, 0, r.out);
      assert.doesNotMatch(r.out, /409/);
    }
    assert.equal(w.interactions.length, 1);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).reports[`${I0}:${M2}`].cardId, "i1");
    w.interactions[0].status = "accepted";
    await run("2026-11-10T17:00:00Z");
    assert.equal(answers(w).length, 1);
  });
});

test("e2e: a red report whose CI then turns green gets one update before its card", async () => {
  await withWorld(async ({ w, run, nightly }) => {
    w.gate0.checks = [{ name: "merge-and-push", status: "completed", conclusion: "failure" }];
    await run("2026-11-10T14:00:00Z");
    assert.equal(w.interactions.length, 0);
    w.gate0.checks = [{ name: "merge-and-push", status: "completed", conclusion: "success" }];
    const r = await run("2026-11-10T15:00:00Z");
    assert.equal(r.code, 0, r.out);
    assert.equal(w.comments.length, 2);
    assert.match(w.comments[1].body, new RegExp(`^<!-- staple-missed-upgrade:update:${I0}:${M2}:upgrade -->`));
    assert.match(w.comments[1].body, /\*\*Recommendation:\*\* Upgrade now to cccccccc/);
    assert.equal(w.interactions.length, 1);
    await run("2026-11-10T16:00:00Z");
    rmSync(path.join(nightly, STATE));
    await run("2026-11-10T17:00:00Z");
    assert.equal(w.comments.length, 2);
    assert.equal(reports(w).length, 1);
    assert.equal(w.interactions.length, 1);
  });
});
