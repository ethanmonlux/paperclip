#!/usr/bin/env node
// Staple missed-upgrade report (STA-225). Run hourly next to the managed installer; it never installs,
// restarts, holds admission or touches the installer's lock.
//
// Usage:
//   staple-missed-upgrade [--dry-run]   check once: report a missed upgrade, raise or follow up the founder card
//
// A report is due when the newest installable certified master commit is still not installed after the
// 03:30 nightly run had its chance (missed nightly), or when a merged change has been uninstalled for two
// hours. The report goes to the installer's upgrade-log issue (STA-193). It lists every merged PR and
// upstream sync between the installed build and the chosen commit, classifies each Critical, Valuable or
// Can wait from its linked Staple defects, and recommends upgrading now or waiting for tonight.
//
// The chosen commit is the installer's own pick (`staple-nightly-upgrade certified-target`), and its CI
// verdict is the installer's Gate 0 (`staple-nightly-upgrade ci-state`), so the report recommends only what
// the installer would install. A Gate 0 `pending` is a CI wait, never a failure: nothing is reported and the
// next hourly check looks again (STA-224). An unreadable read is retried the same way.
//
// A founder card (Upgrade now / Wait for tonight) is raised only for a Critical change or a Valuable one
// whose wait costs a day of blocked work. One report and at most one card exist per (installed build,
// chosen commit) pair across hourly checks and restarts: the pair is kept in the state file, marked in the
// report comment, and used as the card's idempotency key. The answer is followed up once on the same issue.
// "Upgrade now" hands the install to the qualified operator; this script never runs the installer.
//
// Environment: STAPLE_API, STAPLE_COMPANY_ID, STAPLE_REPO, STAPLE_BRANCH, STAPLE_GITHUB_TOKEN as for the
// installer; STAPLE_UPGRADE_BIN (default ~/.local/bin/staple-nightly-upgrade), STAPLE_NIGHTLY_DIR (default
// ~/.paperclip/nightly), STAPLE_TZ (default America/Denver), STAPLE_GITHUB_API (tests).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const NIGHTLY = { hour: 3, minute: 30 }; // the managed installer's nightly run
export const NIGHTLY_DONE_MIN = 60; // the 03:30 run has finished (drain, build, verify) an hour later
export const INSTALLER_WINDOW = { from: 2 * 60 + 15, to: 4 * 60 + 30 }; // hold at 02:30, upgrade at 03:30
export const UNINSTALLED_TRIGGER_MS = 2 * 60 * 60 * 1000;
export const DAYTIME_DRAIN_MIN = 10; // the card's expected drain; the operator passes it as HOLD_DRAIN_MIN
export const INSTALL_MIN = 10; // backup, build, restart and verify
const MARKER = "staple-missed-upgrade";
const DONE = new Set(["done", "cancelled"]);

// --- time ---------------------------------------------------------------------------------------

function zoneParts(date, timeZone) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, s: +p.second };
}

/** The instant of a wall-clock time in a time zone. */
export function zonedTime(y, m, d, h, min, timeZone) {
  let t = Date.UTC(y, m - 1, d, h, min);
  for (let i = 0; i < 2; i++) {
    const p = zoneParts(new Date(t), timeZone);
    t -= Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Date.UTC(y, m - 1, d, h, min);
  }
  return new Date(t);
}

/** The most recent nightly run time at or before now, and whether that run has had time to finish. */
export function lastNightly(now, timeZone) {
  const p = zoneParts(now, timeZone);
  let at = zonedTime(p.y, p.m, p.d, NIGHTLY.hour, NIGHTLY.minute, timeZone);
  if (at > now) {
    const y = zoneParts(new Date(at.getTime() - 24 * 3600 * 1000), timeZone);
    at = zonedTime(y.y, y.m, y.d, NIGHTLY.hour, NIGHTLY.minute, timeZone);
  }
  return { at, finished: now.getTime() >= at.getTime() + NIGHTLY_DONE_MIN * 60 * 1000 };
}

export function inInstallerWindow(now, timeZone) {
  const p = zoneParts(now, timeZone);
  const minutes = p.h * 60 + p.min;
  return minutes >= INSTALLER_WINDOW.from && minutes < INSTALLER_WINDOW.to;
}

function localDate(date, timeZone) {
  const p = zoneParts(date, timeZone);
  return `${p.y}${String(p.m).padStart(2, "0")}${String(p.d).padStart(2, "0")}`;
}

function ago(ms) {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

// --- history and classification -----------------------------------------------------------------

/**
 * First-parent commits after `from` up to and including `to`, oldest first. `commits` is GitHub's
 * compare list (every commit in from...to, with parents). Returns null when `to` does not reach `from`.
 */
export function firstParentRange(commits, from, to) {
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const out = [];
  let sha = to;
  while (sha && sha !== from) {
    const c = bySha.get(sha);
    if (!c) return null;
    out.push(c);
    sha = c.parents?.[0]?.sha;
  }
  return sha === from ? out.reverse() : null;
}

export function mergedPrNumber(message) {
  const m = /^Merge pull request #(\d+) /.exec(message || "");
  return m ? Number(m[1]) : null;
}

export function isUpstreamSync(pr) {
  return /^staple\/upstream-sync-/.test(pr.headRef || "") || /^Staple upstream sync\b/i.test(pr.title || "");
}

/** Staple issues a PR is for: its title and branch, or else the body's closes/fixes/refs lines. */
export function linkedIssueIds(pr, prefix = "STA") {
  const re = new RegExp(`\\b${prefix}-\\d+\\b`, "gi");
  const found = (s) => (s || "").match(re) || [];
  let ids = [...found(pr.title), ...found(pr.headRef)];
  if (!ids.length) {
    const refs = new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?|part of)\\s+${prefix}-\\d+`, "gi");
    ids = found(((pr.body || "").match(refs) || []).join(" "));
  }
  return [...new Set(ids.map((x) => x.toUpperCase()))];
}

function changeType(title) {
  const m = /^(\w+)(?:\([^)]*\))?!?:/.exec(title || "");
  return m ? m[1].toLowerCase() : null;
}

/**
 * Critical: a linked defect is critical (it strands agents or work now).
 * Valuable: a linked defect is high, or the change is an unlinked fix. It costs a day when the defect
 *   still blocks open work, so waiting for tonight keeps that work stuck.
 * Can wait: everything else, including CI, test, chore and docs changes without a critical defect.
 */
export function classify(change, issues) {
  const linked = change.linked.map((id) => issues.get(id)).filter(Boolean);
  const critical = linked.filter((i) => i.priority === "critical");
  if (critical.length) {
    return { cls: "Critical", dayCostly: true, why: critical.map((i) => `${i.identifier} is critical: ${i.title}`) };
  }
  const type = changeType(change.title);
  if (["ci", "test", "chore", "docs", "build", "style"].includes(type)) {
    return { cls: "Can wait", dayCostly: false, why: [`${type} change`] };
  }
  const high = linked.filter((i) => i.priority === "high");
  if (high.length) {
    const blocked = high.flatMap((i) => (i.blocks || []).filter((b) => !DONE.has(b.status)).map((b) => b.identifier));
    return blocked.length
      ? { cls: "Valuable", dayCostly: true, why: [`${high.map((i) => i.identifier).join(", ")} still blocks open work (${[...new Set(blocked)].join(", ")})`] }
      : { cls: "Valuable", dayCostly: false, why: [`${high.map((i) => `${i.identifier}: ${i.title}`).join("; ")}`] };
  }
  if (type === "fix" && !linked.length) return { cls: "Valuable", dayCostly: false, why: ["unlinked fix"] };
  return { cls: "Can wait", dayCostly: false, why: [linked.length ? `${linked.map((i) => `${i.identifier} is ${i.priority}`).join(", ")}` : "no linked Staple defect"] };
}

// --- the decision -------------------------------------------------------------------------------

export function reportKey(installed, target, criticalPrs = []) {
  return target ? `${installed}:${target}` : `${installed}:uncertified:${criticalPrs.join(",")}`;
}

function itemLine(c) {
  const what = c.pr ? `PR #${c.pr} ${c.title}` : `${c.sha.slice(0, 8)} ${c.title}`;
  const tag = c.cls === "Valuable" && c.dayCostly ? "Valuable, costs a day" : c.cls;
  let line = `- **${tag}**: ${what}. ${c.why.join("; ")}.`;
  if (c.upstream?.length) {
    const shown = c.upstream.slice(0, 15).map((s) => `  - ${s}`);
    if (c.upstream.length > 15) shown.push(`  - and ${c.upstream.length - 15} more upstream commits`);
    line += `\n  Upstream changes:\n${shown.join("\n")}`;
  }
  return line;
}

/**
 * Decide one hourly check. Pure: every input is read before. Returns
 *   { kind: "silent", reason }                     nothing to report this hour
 *   { kind: "report", key, title, body, card }     post the report; card is null or a confirmation payload
 */
export function evaluate(x) {
  const short = (s) => (s || "").slice(0, 8);
  if (inInstallerWindow(x.now, x.timeZone)) return { kind: "silent", reason: "the nightly installer window is open" };
  if (!x.installed || !x.master) return { kind: "silent", reason: "installed or master commit unreadable; retry" };
  if (x.installed === x.master) return { kind: "silent", reason: "installed is master" };
  if (x.pick.startsWith("error:")) return { kind: "silent", reason: `certification unreadable (${x.pick.slice(6)}); retry` };
  if (x.changes === null) return { kind: "silent", reason: "installed is not on master's first-parent history, or it is unreadable; retry" };
  const target = x.pick.startsWith("target:") ? x.pick.slice(7).split(" ")[0] : null;
  if (target && x.targetAhead === false) return { kind: "silent", reason: `certified ${short(target)} is not ahead of installed` };
  if (target && x.gate0.startsWith("pending:")) return { kind: "silent", reason: `pending, retry: master ${short(target)} CI still running (${x.gate0.slice(8)})` };
  if (target && x.gate0.startsWith("error:")) return { kind: "silent", reason: `Gate 0 unreadable (${x.gate0.slice(6)}); retry` };
  if (!target && x.masterCert === "pending") return { kind: "silent", reason: `pending, retry: certification of master ${short(x.master)} still running` };
  if (!target && x.masterCert === "unreadable") return { kind: "silent", reason: `certification of master ${short(x.master)} unreadable; retry` };

  const ti = target ? x.changes.findIndex((c) => c.sha === target) : -1;
  if (target && ti < 0) return { kind: "silent", reason: `certified ${short(target)} is not on master's first-parent history after installed` };
  const installable = target ? x.changes.slice(0, ti + 1) : [];
  const later = target ? x.changes.slice(ti + 1) : x.changes;
  const nightly = lastNightly(x.now, x.timeZone);
  const oldest = (target ? installable : later)[0];
  const waited = oldest ? x.now.getTime() - new Date(oldest.mergedAt).getTime() : 0;
  const triggers = [];
  if (target && x.certifiedAt && new Date(x.certifiedAt) < nightly.at && nightly.finished) {
    triggers.push(`the ${x.nightlyLog?.date ?? "last"} 03:30 nightly run did not install ${short(target)}, certified before it`);
  }
  if (oldest && waited >= UNINSTALLED_TRIGGER_MS) {
    triggers.push(`${oldest.pr ? `PR #${oldest.pr}` : short(oldest.sha)} has been merged and uninstalled for ${ago(waited)}`);
  }
  if (!triggers.length) return { kind: "silent", reason: "within the nightly cycle and under two hours uninstalled" };

  const green = !target || x.gate0 === "green";
  const pool = target && green ? installable : [];
  const urgent = pool.filter((c) => c.cls === "Critical" || (c.cls === "Valuable" && c.dayCostly));
  const criticalLater = later.filter((c) => c.cls === "Critical").map((c) => c.pr ?? short(c.sha));
  const key = reportKey(x.installed, target, target ? [] : criticalLater);

  let recommendation;
  if (target && !green) {
    recommendation = `No upgrade available: Gate 0 blocks ${short(target)} because its CI is not green (${x.gate0}). Fix or rerun that CI; the installer does not install a commit with failed CI.`;
  } else if (!target) {
    recommendation = criticalLater.length
      ? `Certify master now: ${criticalLater.map((p) => (typeof p === "number" ? `PR #${p}` : p)).join(", ")} is Critical but no newer commit is certified. Dispatch \`staple-certify.yml\` on master; once it certifies, the next check offers the upgrade.`
      : "Wait for tonight: the 22:45 certification and the 03:30 run install these changes.";
  } else {
    recommendation = urgent.length
      ? `Upgrade now to ${short(target)}: ${urgent.length} change${urgent.length > 1 ? "s" : ""} below cannot wait for tonight.`
      : `Wait for tonight: nothing below is Critical or costs a day. The 03:30 run installs ${short(target)}.`;
  }
  if (target && green && criticalLater.length) {
    recommendation += ` ${criticalLater.map((p) => (typeof p === "number" ? `PR #${p}` : p)).join(", ")}, merged after it, is Critical but not certified yet: dispatch \`staple-certify.yml\` on master.`;
  }

  const lines = [
    `<!-- ${MARKER}:${key} -->`,
    `**Trigger:** ${triggers.join("; ")}.`,
    "",
    `- Installed: \`${short(x.installed)}\` (from \`/api/health\`).`,
    target
      ? `- Chosen commit: \`${target}\`, the newest certified master commit (\`staple/certified\` success${x.certifiedAt ? ` at ${x.certifiedAt}` : ""}). Gate 0 CI: \`${x.gate0}\`.`
      : `- No certified master commit newer than the installed build (\`${x.pick}\`; master \`${short(x.master)}\` certification: \`${x.masterCert || "missing"}\`).`,
    x.nightlyLog
      ? `- Nightly log \`${x.nightlyLog.file}\`: ${x.nightlyLog.reports.length ? x.nightlyLog.reports.map((r) => `\`${r}\``).join("; ") : "no REPORT line"}.`
      : `- No nightly upgrade log for ${localDate(nightly.at, x.timeZone).replace(/^(\d{4})(\d\d)/, "$1-$2-")}: the 03:30 run did not start.`,
    "",
    `**Recommendation:** ${recommendation}`,
  ];
  if (target) {
    lines.push("", `**Installable now (\`${short(x.installed)}..${short(target)}\`):**`, ...installable.map(itemLine));
  }
  if (later.length) {
    lines.push("", target ? `**Merged after \`${short(target)}\`, not certified yet:**` : "**Merged and not certified yet:**", ...later.map(itemLine));
  }
  const title = target
    ? `Missed upgrade: ${short(target)} not installed (installed ${short(x.installed)})`
    : `Uninstalled merges: nothing newer than ${short(x.installed)} is certified`;

  let card = null;
  if (urgent.length) {
    const running = typeof x.runningRuns === "number" ? `${x.runningRuns} run${x.runningRuns === 1 ? " is" : "s are"} running now. ` : "";
    card = {
      kind: "request_confirmation",
      idempotencyKey: `${MARKER}:card:${key}`,
      resolverPolicy: "human_only",
      continuationPolicy: "none",
      title: `Upgrade Staple to ${short(target)} now?`,
      payload: {
        version: 1,
        prompt: `Upgrade Staple now to ${short(target)}, or wait for tonight's 03:30 run?`,
        acceptLabel: "Upgrade now",
        rejectLabel: "Wait for tonight",
        allowDeclineReason: true,
        detailsMarkdown: [
          `Chosen commit: \`${target}\` (newest certified master, CI green). Installed: \`${short(x.installed)}\`.`,
          "",
          "**Why it can't wait:**",
          ...urgent.map(itemLine),
          "",
          `**Expected time:** a drain of up to ${DAYTIME_DRAIN_MIN} minutes, then about ${INSTALL_MIN} minutes to back up, build, restart and verify. ${running}Runs still going at the drain deadline are parked with a queued continuation, never cancelled. A failed check rolls back automatically.`,
          "",
          `**Upgrade now:** the qualified operator runs the managed installer today. **Wait for tonight:** the 03:30 run installs it.`,
        ].join("\n"),
      },
    };
  }
  return { kind: "report", key, title, body: lines.join("\n"), card };
}

/**
 * Follow up a raised card. `entry` is the state record; `card` is the live interaction (or undefined).
 * Returns { comment, closed, withdraw } where comment may be null.
 */
export function followUpCard(entry, card, installed) {
  const short = (s) => (s || "").slice(0, 8);
  if (!card) return { comment: null, closed: false, withdraw: false };
  if (card.status === "accepted") {
    return {
      closed: true, withdraw: false,
      comment: `<!-- ${MARKER}:answer:${entry.key} -->\n**Upgrade now chosen** for \`${short(entry.target)}\`. Handoff to the qualified operator: run the managed installer today with a short drain, \`HOLD_DRAIN_MIN=${DAYTIME_DRAIN_MIN} ~/.local/bin/staple-nightly-upgrade\` (hold, drain, backup, install, verify, rollback on failure). This check does not install or restart Staple.`,
    };
  }
  if (card.status === "rejected") {
    return {
      closed: true, withdraw: false,
      comment: `<!-- ${MARKER}:answer:${entry.key} -->\n**Wait for tonight chosen** for \`${short(entry.target)}\`. The 03:30 run installs it if it is still the newest certified commit. No new card for this pair.`,
    };
  }
  if (card.status === "pending" && installed && installed !== entry.installed) {
    return { closed: true, withdraw: true, comment: null };
  }
  return { comment: null, closed: card.status !== "pending", withdraw: false };
}

// --- I/O ----------------------------------------------------------------------------------------

const env = process.env;
const API = env.STAPLE_API || "http://127.0.0.1:3100";
const CID = env.STAPLE_COMPANY_ID || "ad240b50-ded9-43bd-b052-da137d595161";
const REPO = env.STAPLE_REPO || "ethanmonlux/paperclip";
const BRANCH = env.STAPLE_BRANCH || "master";
const GH = env.STAPLE_GITHUB_API || "https://api.github.com";
const NIGHTLY_DIR = env.STAPLE_NIGHTLY_DIR || path.join(homedir(), ".paperclip", "nightly");
const UPGRADE_BIN = env.STAPLE_UPGRADE_BIN || path.join(homedir(), ".local", "bin", "staple-nightly-upgrade");
const TZ = env.STAPLE_TZ || "America/Denver";

function boardToken() {
  if (env.STAPLE_BOARD_TOKEN) return env.STAPLE_BOARD_TOKEN;
  try {
    const find = (o) => {
      if (Array.isArray(o)) { for (const v of o) { const r = find(v); if (r) return r; } }
      else if (o && typeof o === "object") {
        for (const [k, v] of Object.entries(o)) {
          if (typeof v === "string" && ["token", "apikey", "api_key", "accesstoken", "bearer", "key"].includes(k.toLowerCase())) return v;
          const r = find(v); if (r) return r;
        }
      }
      return null;
    };
    return find(JSON.parse(readFileSync(path.join(homedir(), ".paperclip", "auth.json"), "utf8"))) || "";
  } catch { return ""; }
}

async function getJson(url, headers) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${r.status} ${url.replace(/\?.*/, "")}`);
  return r.json();
}

function gh(p) {
  const h = { Accept: "application/vnd.github+json" };
  if (env.STAPLE_GITHUB_TOKEN) h.Authorization = `Bearer ${env.STAPLE_GITHUB_TOKEN}`;
  return getJson(`${GH}/repos/${REPO}/${p}`, h);
}

async function ghPages(p, key) {
  const items = []; let total = 0;
  for (let page = 1; page <= 10; page++) {
    let d;
    try { d = await gh(`${p}${p.includes("?") ? "&" : "?"}per_page=100&page=${page}`); }
    catch (e) { return { message: String(e.message).slice(0, 200) }; }
    if (!d || !Array.isArray(d[key])) return d;
    items.push(...d[key]); total = d.total_count ?? items.length;
    if (items.length >= total || d[key].length < 100) break;
  }
  return { total_count: total, [key]: items };
}

function staple(token) {
  const h = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  return {
    get: (p) => getJson(`${API}/api${p}`, h),
    async send(method, p, body) {
      const r = await fetch(`${API}/api${p}`, { method, headers: h, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
      const text = await r.text();
      if (!r.ok) throw new Error(`${method} ${p}: HTTP ${r.status} ${text.slice(0, 200)}`);
      return text ? JSON.parse(text) : {};
    },
  };
}

function installer(args, extraEnv = {}) {
  const r = spawnSync("bash", [UPGRADE_BIN, ...args], { encoding: "utf8", env: { ...env, ...extraEnv }, timeout: 120000 });
  return (r.stdout || "").trim().split("\n").pop() || `error:${UPGRADE_BIN} exited ${r.status}`;
}

function certState(statuses) {
  if (!Array.isArray(statuses)) return { state: null, at: null };
  const s = statuses.find((x) => x?.context === "staple/certified");
  return { state: s?.state ?? null, at: s?.created_at ?? null };
}

function nightlyLog(now) {
  const day = localDate(lastNightly(now, TZ).at, TZ);
  let files = [];
  try { files = readdirSync(NIGHTLY_DIR).filter((f) => f.startsWith(`upgrade-${day}-`)).sort(); } catch { return null; }
  if (!files.length) return null;
  const file = files[files.length - 1];
  const reports = readFileSync(path.join(NIGHTLY_DIR, file), "utf8").split("\n")
    .map((l) => /REPORT: (.*)$/.exec(l)?.[1] || (/(Already on master\. Nothing to do\.|another upgrade run holds the lock)/.exec(l)?.[1]))
    .filter(Boolean);
  return { file, date: `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}`, reports };
}

// Every commit in from...to. An upstream sync brings hundreds of second-parent commits, so read every page.
async function compareAll(from, to) {
  const commits = []; let status = "";
  for (let page = 1; page <= 10; page++) {
    const d = await gh(`compare/${from}...${to}?per_page=100&page=${page}`);
    status = d.status; commits.push(...(d.commits || []));
    if (!d.commits?.length || commits.length >= (d.total_commits ?? 0)) break;
  }
  return { status, commits };
}

// A merged PR does not change, so its details are read once and kept in the state file.
async function prInfo(number, cache) {
  if (cache[number]) return cache[number];
  const p = await gh(`pulls/${number}`);
  const info = { title: p.title, headRef: p.head?.ref, body: (p.body || "").slice(0, 4000), upstream: null };
  if (isUpstreamSync(info)) {
    info.upstream = [];
    for (let page = 1; page <= 3; page++) {
      const commits = await gh(`pulls/${number}/commits?per_page=100&page=${page}`);
      if (!Array.isArray(commits)) break;
      info.upstream.push(...commits.map((x) => x.commit?.message?.split("\n")[0]).filter((s) => s && !/^Merge /.test(s)));
      if (commits.length < 100) break;
    }
  }
  if (p.merged_at) cache[number] = info;
  return info;
}

async function changesBetween(from, to, issueLookup, cache) {
  const cmp = await compareAll(from, to);
  const range = firstParentRange(cmp.commits, from, to);
  if (!range) return { ahead: cmp.status === "ahead", changes: null };
  const changes = [];
  for (const c of range) {
    const message = c.commit?.message || "";
    const pr = mergedPrNumber(message);
    const ch = { sha: c.sha, mergedAt: c.commit?.committer?.date, pr, title: message.split("\n")[0], linked: [], upstream: null };
    if (pr) {
      const info = await prInfo(pr, cache);
      ch.title = info.title; ch.linked = linkedIssueIds(info); ch.upstream = info.upstream;
    }
    for (const id of ch.linked) await issueLookup(id);
    changes.push(ch);
  }
  return { ahead: cmp.status === "ahead", changes };
}

function loadState(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return { reports: {} }; }
}

function saveState(file, state) {
  writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2));
  renameSync(`${file}.tmp`, file);
}

export async function main(argv = process.argv.slice(2)) {
  const dry = argv.includes("--dry-run");
  const unknown = argv.filter((a) => a !== "--dry-run");
  if (unknown.length) { console.error(`unknown argument: ${unknown[0]}`); return 2; }
  const now = env.STAPLE_NOW ? new Date(env.STAPLE_NOW) : new Date();
  const say = (s) => console.log(`[${now.toISOString()}] ${s}`);
  const api = staple(boardToken());
  const stateFile = path.join(NIGHTLY_DIR, "missed-upgrade-state.json");
  const state = loadState(stateFile);
  state.reports ||= {};
  state.prs ||= {};
  let reportIssue = env.STAPLE_REPORT_ISSUE;
  if (!reportIssue) { try { reportIssue = readFileSync(path.join(NIGHTLY_DIR, "report-issue-id"), "utf8").trim(); } catch { /* none yet */ } }
  if (!reportIssue) { say("no upgrade-log issue yet (report-issue-id); the installer creates it"); return 0; }

  let installed = "";
  try { installed = (await getJson(`${API}/api/health`, {})).commit || ""; } catch { /* unreadable: silent below */ }

  // Follow up raised cards first: an answer is reported once, a card made stale by an install is withdrawn.
  for (const entry of Object.values(state.reports)) {
    if (!entry.cardId || entry.cardClosed) continue;
    let card;
    try { card = (await api.get(`/issues/${reportIssue}/interactions`)).find((i) => i.id === entry.cardId); }
    catch (e) { say(`card ${entry.cardId} unreadable (${e.message}); retry`); continue; }
    const f = followUpCard(entry, card, installed);
    if (dry) { say(`DRY RUN: card ${entry.cardId} ${card?.status}: ${f.comment ?? (f.withdraw ? "withdraw" : "no action")}`); continue; }
    if (f.withdraw) {
      try { await api.send("POST", `/issues/${reportIssue}/interactions/${entry.cardId}/withdraw`, { reason: `Superseded: installed is now ${installed.slice(0, 8)}.` }); }
      catch (e) { say(`withdraw of card ${entry.cardId} failed (${e.message}); retry`); continue; }
    }
    if (f.comment) await api.send("POST", `/issues/${reportIssue}/comments`, { body: f.comment });
    if (f.closed) { entry.cardClosed = card?.status === "pending" ? "withdrawn" : card.status; saveState(stateFile, state); say(`card ${entry.cardId}: ${entry.cardClosed}`); }
  }

  let master = "";
  try { master = (await gh(`commits/${BRANCH}`)).sha || ""; } catch { /* unreadable: silent below */ }
  const issues = new Map();
  const lookup = async (id) => {
    if (issues.has(id)) return;
    try {
      const i = await api.get(`/issues/${id}`);
      issues.set(id, { identifier: i.identifier, title: i.title, priority: i.priority, status: i.status, blocks: (i.blocks || []).map((b) => ({ identifier: b.identifier, status: b.status })) });
    } catch { issues.set(id, null); }
  };

  const x = { now, timeZone: TZ, installed, master, pick: "error:not read", gate0: "", changes: null, targetAhead: true, certifiedAt: null, masterCert: null, nightlyLog: nightlyLog(now), runningRuns: null };
  if (installed && master && installed !== master && !inInstallerWindow(now, TZ)) {
    x.pick = installer(["certified-target", installed]);
    try {
      const r = await changesBetween(installed, master, lookup, state.prs);
      x.changes = r.changes; x.targetAhead = r.ahead;
    } catch (e) { say(`history unreadable (${e.message})`); }
    const target = x.pick.startsWith("target:") ? x.pick.slice(7).split(" ")[0] : null;
    if (target) {
      try { x.certifiedAt = certState(await gh(`commits/${target}/statuses?per_page=100`)).at; } catch { /* reported without a time */ }
      const dir = mkdtempSync(path.join(tmpdir(), "staple-missed-"));
      try {
        writeFileSync(path.join(dir, "checks.json"), JSON.stringify(await ghPages(`commits/${target}/check-runs`, "check_runs")));
        writeFileSync(path.join(dir, "runs.json"), JSON.stringify(await ghPages(`actions/runs?head_sha=${target}`, "workflow_runs")));
        x.gate0 = installer(["ci-state", path.join(dir, "checks.json"), path.join(dir, "runs.json")]);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    } else {
      try {
        x.masterCert = certState(await gh(`commits/${master}/statuses?per_page=100`)).state;
        const runs = await gh(`actions/workflows/staple-certify.yml/runs?head_sha=${master}&per_page=20`);
        if ((runs.workflow_runs || []).some((r) => r.status !== "completed")) x.masterCert = "pending";
      } catch { x.masterCert = "unreadable"; }
    }
    for (const c of x.changes || []) Object.assign(c, classify(c, issues));
    try {
      const runs = await api.get(`/companies/${CID}/heartbeat-runs?status=running&limit=50`);
      x.runningRuns = (Array.isArray(runs) ? runs : runs.items || []).filter((r) => r.status === "running").length;
    } catch { /* the card omits the count */ }
  }

  if (!dry) saveState(stateFile, state); // keeps the PR cache
  const d = evaluate(x);
  if (d.kind === "silent") { say(`no report: ${d.reason}`); return 0; }
  const target = d.key.split(":")[1];
  let entry = state.reports[d.key];
  if (!entry) {
    // A lost state file must not repeat a report or an answer: the comments carry the pair.
    let list;
    try {
      const comments = await api.get(`/issues/${reportIssue}/comments?order=desc&limit=100`);
      list = Array.isArray(comments) ? comments : comments.comments || comments.items || [];
    } catch (e) { say(`upgrade-log comments unreadable (${e.message}); retry`); return 1; }
    const prior = list.find((c) => (c.body || "").includes(`<!-- ${MARKER}:${d.key} -->`));
    if (prior) {
      const answered = list.some((c) => (c.body || "").includes(`<!-- ${MARKER}:answer:${d.key} -->`));
      let card = null;
      try { card = (await api.get(`/issues/${reportIssue}/interactions`)).find((i) => i.idempotencyKey === `${MARKER}:card:${d.key}`) ?? null; }
      catch (e) { say(`upgrade-log cards unreadable (${e.message}); retry`); return 1; }
      entry = { key: d.key, installed, target, commentId: prior.id, cardId: card?.id ?? null, cardClosed: answered ? card?.status ?? "answered" : undefined, at: now.toISOString(), recovered: true };
      if (!dry) { state.reports[d.key] = entry; saveState(stateFile, state); }
      say(`already reported ${d.key} (comment ${prior.id})`);
    }
  } else {
    say(`already reported ${d.key}`);
  }
  if (dry) {
    if (!entry) say(`DRY RUN: would report ${d.key}\n## ${d.title}\n${d.body}`);
    if (d.card && !entry?.cardId) say(`DRY RUN: would raise the card ${d.card.idempotencyKey}\n${d.card.payload.detailsMarkdown}`);
    return 0;
  }
  if (!entry) {
    const comment = await api.send("POST", `/issues/${reportIssue}/comments`, { body: `**${d.title}**\n\n${d.body}` });
    entry = { key: d.key, installed, target, commentId: comment.id ?? null, cardId: null, at: now.toISOString() };
    state.reports[d.key] = entry; saveState(stateFile, state);
    say(`REPORT: ${d.title}`);
  }
  if (d.card && !entry.cardId && !entry.cardClosed) {
    // The idempotency key makes a retry after a crash return the same card, never a second one.
    const card = await api.send("POST", `/issues/${reportIssue}/interactions`, d.card);
    entry.cardId = card.id ?? null; saveState(stateFile, state);
    say(`card raised: ${entry.cardId}`);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (e) => { console.error(`staple-missed-upgrade failed: ${e.message}`); process.exit(1); });
}
