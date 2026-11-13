/**
 * Staple Console upgrade card (FAC-620 upgrade-status direction, STA-214).
 *
 * The managed installer (`scripts/staple/staple-nightly-upgrade.sh`, the only install path)
 * writes one timestamped line per step to `~/.paperclip/nightly/`. This module turns those
 * lines, the maintenance-hold record and the running build into one read-only status: the
 * stage an attempt has reached, how long it has taken, when the installer last wrote
 * anything, what is held, and what happens next. It never returns a raw log line: only stage
 * names, times, short SHAs, counts and the installer's one-line outcome, rewritten to fixed
 * wording so no path or error text from the host reaches the page.
 *
 * The installer reports no download size, so download and build are one stage and its size is
 * unknown. Nothing here estimates a percent or an ETA.
 */

export const STAPLE_UPGRADE_STAGES = ["certification", "draining", "backup", "download_build", "restart", "verify"] as const;
export type StapleConsoleUpgradeStageKey = (typeof STAPLE_UPGRADE_STAGES)[number];

export const STAPLE_UPGRADE_STAGE_LABELS: Record<StapleConsoleUpgradeStageKey | "rollback", string> = {
  certification: "Certified + CI",
  draining: "Drain",
  backup: "Backup",
  download_build: "Download + build",
  restart: "Restart",
  verify: "Verify",
  rollback: "Rollback",
};

/** One-word labels for the 6-cell strip, which has to fit a 380 px phone without wrapping. */
export const STAPLE_UPGRADE_STAGE_SHORT: Record<StapleConsoleUpgradeStageKey, string> = {
  certification: "Certify",
  draining: "Drain",
  backup: "Backup",
  download_build: "Build",
  restart: "Restart",
  verify: "Verify",
};

/**
 * running      an attempt (or the nightly hold before it) is in progress
 * waiting      the last check deferred for an expected reason: busy, CI still running, nothing certified
 * up_to_date   the last check found the installed build current
 * verified     the last attempt installed, passed health, startup and smoke checks
 * skipped      the last attempt stopped before installing for an unexpected reason
 * failed       the install or backup failed; the installed build is unchanged
 * rolled_back  the new build failed checks and the previous one is back
 * needs_ethan  upgrade and rollback both failed
 * stale        an attempt is open but the installer has written nothing for too long
 * unknown      no readable installer record
 */
export type StapleConsoleUpgradePhase =
  | "running"
  | "waiting"
  | "up_to_date"
  | "verified"
  | "skipped"
  | "failed"
  | "rolled_back"
  | "needs_ethan"
  | "stale"
  | "unknown";

export type StapleConsoleUpgradeStageState = "done" | "current" | "failed" | "pending" | "skipped";

export interface StapleConsoleUpgradeStageCell {
  key: StapleConsoleUpgradeStageKey;
  label: string;
  state: StapleConsoleUpgradeStageState;
  /** Null when the installer does not timestamp the stage's start. */
  startedAt: string | null;
}

export interface StapleConsoleUpgradeHold {
  since: string;
  drainDeadlineAt: string;
  expiresAt: string;
  queuedWakes: number;
  runningRuns: number;
  parkedRuns: number;
}

export interface StapleConsoleUpgradeStatus {
  phase: StapleConsoleUpgradePhase;
  /** One short line: the state in plain words. */
  headline: string;
  /** Daytime quiet-window path rather than the nightly window. */
  quiet: boolean;
  attemptStartedAt: string | null;
  attemptEndedAt: string | null;
  stage: StapleConsoleUpgradeStageKey | "rollback" | null;
  stageStartedAt: string | null;
  stages: StapleConsoleUpgradeStageCell[];
  installed: string | null;
  target: string | null;
  master: string | null;
  /** Last time the installer wrote anything: the freshest real progress. */
  lastOutputAt: string | null;
  /** Running work while draining. */
  drainRunning: number | null;
  /** Measured download bytes; both null while the installer reports none. */
  download: { bytes: number | null; totalBytes: number | null } | null;
  /** The installer's own one-line outcome, clipped. */
  outcome: string | null;
  nextAction: string | null;
  /** Present only when Ethan has to act. */
  needsEthan: string | null;
  hold: StapleConsoleUpgradeHold | null;
  /** The newest attempt that installed or tried to, when the current line is only a check. */
  lastInstall: { phase: "verified" | "failed" | "rolled_back" | "needs_ethan"; at: string; from: string | null; to: string | null } | null;
  source: { available: boolean; detail: string; logName: string | null };
}

export interface StapleUpgradeLogFile {
  name: string;
  text: string;
  modifiedAt: string;
  /** The text starts inside an attempt whose `==` start line was too far back to read. */
  startUnread?: boolean;
}

export interface StapleConsoleUpgradeInput {
  now: string;
  /** Time zone of the installer's `date '+%F %T'` timestamps (the host's). */
  timeZone: string;
  /** Null when the log directory cannot be read. */
  logs: StapleUpgradeLogFile[] | null;
  hold: StapleConsoleUpgradeHold | null;
  installedBuild: string | null;
  serverStartedAt: string | null;
  /** Next nightly attempt (03:30 local), computed by the caller. */
  nextNightlyAt: string | null;
}

/** No installer output for this long marks an open attempt stale. Builds print often; restarts poll quietly for 5 min. */
export const STAPLE_UPGRADE_STALE_MS = 10 * 60_000;
export const STAPLE_UPGRADE_BUILD_STALE_MS = 20 * 60_000;

const LINE_RE = /^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\] (.*)$/;
const SHORT = (sha: string | null | undefined) => (sha && /^[0-9a-f]{7,40}$/.test(sha) ? sha.slice(0, 8) : null);

function clip(text: string, max = 160) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function zoneOffsetMs(utcMs: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - utcMs;
}

/** A wall-clock time in `timeZone` as an ISO instant. */
export function stapleUpgradeLocalToIso(
  fields: [number, number, number, number, number, number],
  timeZone: string,
): string | null {
  const [year, month, day, hour, minute, second] = fields;
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!Number.isFinite(naive)) return null;
  let candidate = naive;
  try {
    for (let pass = 0; pass < 2; pass += 1) candidate = naive - zoneOffsetMs(candidate, timeZone);
  } catch {
    return null;
  }
  return new Date(candidate).toISOString();
}

interface LogLine { at: string; text: string }

interface Attempt {
  kind: "upgrade" | "hold";
  logName: string;
  quiet: boolean;
  dry: boolean;
  startedAt: string;
  lines: LogLine[];
  /** Untimestamped output (the install's own) after the attempt's last timestamped line. */
  rawAfter: string[];
  modifiedAt: string;
  isLastInFile: boolean;
  /** Its start line wasn't read, so its kind, target and stages are unknown. */
  startUnread: boolean;
}

function parseAttempts(file: StapleUpgradeLogFile, timeZone: string): Attempt[] {
  const attempts: Attempt[] = [];
  let current: Attempt | null = null;
  const unread = (at: string): Attempt => ({
    kind: "upgrade", logName: file.name, quiet: false, dry: false, startedAt: at, lines: [], rawAfter: [],
    modifiedAt: file.modifiedAt, isLastInFile: false, startUnread: true,
  });
  if (file.startUnread) attempts.push((current = unread(file.modifiedAt)));
  let sawTimestamp = false;
  for (const raw of file.text.split(/\r?\n/)) {
    const match = LINE_RE.exec(raw);
    if (!match) {
      if (current && raw.trim()) current.rawAfter.push(raw.trim());
      continue;
    }
    const at = stapleUpgradeLocalToIso(
      [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6])],
      timeZone,
    );
    if (!at) continue;
    // An attempt that started before the readable text began starts, as far as we know, here.
    if (!sawTimestamp && current?.startUnread) current.startedAt = at;
    sawTimestamp = true;
    const text = match[7]!;
    const upgrade = /^== Staple nightly upgrade \(dry=(\d) quiet=(\d)\)/.exec(text);
    const hold = /^== Staple maintenance hold/.test(text);
    if (upgrade || hold) {
      current = {
        kind: upgrade ? "upgrade" : "hold",
        logName: file.name,
        quiet: upgrade ? upgrade[2] === "1" : false,
        dry: upgrade ? upgrade[1] === "1" : false,
        startedAt: at,
        lines: [],
        rawAfter: [],
        modifiedAt: file.modifiedAt,
        isLastInFile: false,
        startUnread: false,
      };
      attempts.push(current);
      continue;
    }
    if (current) {
      current.lines.push({ at, text });
      // Untimestamped install output belongs to the step that printed before it.
      current.rawAfter = [];
    }
  }
  if (attempts.length > 0) attempts[attempts.length - 1]!.isLastInFile = true;
  return attempts;
}

type Terminal = {
  phase: Exclude<StapleConsoleUpgradePhase, "running" | "stale" | "unknown">;
  text: string;
  at: string;
};

const BUSY_RE = /run\(s\) (still )?running (after the drain deadline|at restart time)/;

const SHA = "[0-9a-f]{7,40}";
/** CI check and context names: no path separators, no free-form error text. */
const SAFE_NAME = /^[A-Za-z0-9 _.:+,-]{1,80}$/;

/**
 * The installer's REPORT reasons as fixed public wording. Its reasons can carry host detail
 * (backup file paths, journalctl or API errors), so only known shapes pass, with SHAs, counts and
 * check names; anything else becomes a generic line for its kind.
 */
const PUBLIC_OUTCOMES: Array<[RegExp, (match: RegExpExecArray) => string]> = [
  [new RegExp(`^Upgraded Staple (${SHA}) -> (${SHA})$`), (m) => `Upgraded Staple ${SHORT(m[1])} -> ${SHORT(m[2])}`],
  [new RegExp(`^Rolled back: (${SHA}) failed checks, back on (${SHA})$`), (m) => `Rolled back: ${SHORT(m[1])} failed checks, back on ${SHORT(m[2])}`],
  [/^NEEDS ETHAN: upgrade and rollback both failed$/, () => "NEEDS ETHAN: upgrade and rollback both failed"],
  [new RegExp(`^Failed: install of (${SHA}) did not complete$`), (m) => `Failed: install of ${SHORT(m[1])} did not complete`],
  [/^Skipped: database backup failed \(backup file (missing|empty)\b/, (m) => `Skipped: database backup failed (backup file ${m[1]})`],
  [/^Skipped: database backup failed \(backup file is \d+ bytes, db:backup reported \d+/, () => "Skipped: database backup failed (backup size mismatch)"],
  [/^Skipped: database backup failed\b/, () => "Skipped: database backup failed"],
  [new RegExp(`^Waiting: no certified master commit newer than installed (${SHA})$`), (m) => `Waiting: no certified master commit newer than installed ${SHORT(m[1])}`],
  [new RegExp(`^Waiting: master (${SHA}) CI still running(?: \\(([^()]*)\\))?$`), (m) => (
    `Waiting: master ${SHORT(m[1])} CI still running${m[2] && SAFE_NAME.test(m[2]) ? ` (${m[2]})` : ""}`
  )],
  [new RegExp(`^Skipped: master (${SHA}) CI is not green\\b`), (m) => `Skipped: master ${SHORT(m[1])} CI is not green`],
  [/^Skipped: (\d+) run\(s\) still running after the drain deadline$/, (m) => `Skipped: ${m[1]} run(s) still running after the drain deadline`],
  [/^Skipped: (\d+) run\(s\) running at restart time$/, (m) => `Skipped: ${m[1]} run(s) running at restart time`],
  [/^Skipped: could not hold admission$/, () => "Skipped: could not hold admission"],
  [/^Skipped: could not read installed or master commit$/, () => "Skipped: could not read installed or master commit"],
  [/^Skipped: could not read master history$/, () => "Skipped: could not read master history"],
  [/^Skipped: no (.+) commit in the last (\d+) master commits$/, (m) => (
    SAFE_NAME.test(m[1]!) ? `Skipped: no ${m[1]} commit in the last ${m[2]} master commits` : "Skipped: no certified commit in recent master history"
  )],
  [/^Skipped: certification unreadable\b/, () => "Skipped: certification unreadable"],
  [new RegExp(`^Skipped: certified (${SHA}) is not ahead of installed (${SHA})\\b`), (m) => `Skipped: certified ${SHORT(m[1])} is not ahead of installed ${SHORT(m[2])}`],
];

export function stapleUpgradePublicOutcome(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  for (const [pattern, render] of PUBLIC_OUTCOMES) {
    const match = pattern.exec(flat);
    if (match) return render(match);
  }
  if (/^Waiting:/.test(flat)) return "Waiting: upgrade deferred";
  if (/^Failed:/.test(flat)) return "Failed: upgrade did not complete";
  if (/^Skipped:/.test(flat)) return "Skipped: stopped before installing";
  return "Installer reported an outcome the Console doesn't recognise";
}

function classifyOutcome(text: string): Terminal["phase"] {
  if (/^Upgraded /.test(text)) return "verified";
  if (/^Rolled back/.test(text)) return "rolled_back";
  if (/^NEEDS ETHAN/.test(text)) return "needs_ethan";
  if (/^Failed:/.test(text)) return "failed";
  if (/^Skipped: database backup failed/.test(text)) return "failed";
  if (/^Waiting:/.test(text)) return "waiting";
  if (/^Skipped:/.test(text) && BUSY_RE.test(text)) return "waiting";
  return "skipped";
}

function terminalOf(attempt: Attempt): Terminal | null {
  for (let index = attempt.lines.length - 1; index >= 0; index -= 1) {
    const { at, text } = attempt.lines[index]!;
    const report = /^REPORT: (.*)$/.exec(text);
    if (report) return { phase: classifyOutcome(report[1]!), text: clip(stapleUpgradePublicOutcome(report[1]!)), at };
    const quietSkip = /^quiet-mode skip \(not reported\): (.*)$/.exec(text);
    if (quietSkip) {
      const phase = classifyOutcome(quietSkip[1]!);
      return { phase: phase === "skipped" ? "waiting" : phase, text: clip(stapleUpgradePublicOutcome(quietSkip[1]!)), at };
    }
    if (/^Already on master\. Nothing to do\./.test(text)) return { phase: "up_to_date", text: "Already on the newest master", at };
    if (/^quiet-mode: busy, not installing now/.test(text)) return { phase: "waiting", text: "Busy: work is running", at };
    const triedRecently = new RegExp(`^quiet-mode: tried (${SHA}) within the hour; waiting`).exec(text);
    if (triedRecently) return { phase: "waiting", text: `tried ${SHORT(triedRecently[1])} within the hour; waiting`, at };
    if (/^no certified commit to install/.test(text)) return { phase: "waiting", text: "No certified commit to install; no hold placed", at };
  }
  return null;
}

interface Progress {
  installed: string | null;
  master: string | null;
  target: string | null;
  reached: Map<StapleConsoleUpgradeStageKey, string | null>;
  failedStage: StapleConsoleUpgradeStageKey | null;
  rollbackAt: string | null;
  drainRunning: number | null;
  verifiedOk: boolean;
}

/**
 * `serverStartedAt` and `installedNow` describe the running process, so pass them only for the
 * open attempt. A finished attempt's stages come from its own lines: a later, unrelated restart
 * must not rewrite where it stopped.
 */
function progressOf(attempt: Attempt, live: { serverStartedAt: string | null; installedNow: string | null } | null): Progress {
  const reached = new Map<StapleConsoleUpgradeStageKey, string | null>();
  const result: Progress = {
    installed: null, master: null, target: null, reached, failedStage: null, rollbackAt: null, drainRunning: null, verifiedOk: false,
  };
  if (attempt.kind === "upgrade") reached.set("certification", attempt.startedAt);
  let installingAt: string | null = null;
  let payloadDone = false;
  for (const [index, { at, text }] of attempt.lines.entries()) {
    let match: RegExpExecArray | null;
    if ((match = /^installed=(\S*) master=(\S*)/.exec(text))) {
      result.installed = SHORT(match[1]) || null;
      result.master = SHORT(match[2]) || null;
    } else if ((match = /^certified target: target:([0-9a-f]{7,40})/.exec(text))) {
      result.target = SHORT(match[1]);
    } else if (/^(quiet-mode check \d|maintenance hold active since)/.test(text)) {
      if (!reached.has("draining")) reached.set("draining", at);
    } else if ((match = /^running or settling work: (\d+)/.exec(text))) {
      if (!reached.has("draining")) reached.set("draining", at);
      result.drainRunning = Number(match[1]);
      if (match[1] === "0" && !reached.has("backup")) reached.set("backup", at);
    } else if ((match = /^backup: (.*)$/.exec(text))) {
      if (!reached.has("backup")) reached.set("backup", at);
      if (!match[1]!.startsWith("file:")) result.failedStage = "backup";
    } else if (/^installing [0-9a-f]+/.test(text)) {
      reached.set("download_build", at);
      installingAt = at;
      // The install prints untimestamped lines; its own success line means the payload is ready.
      const next = attempt.lines[index + 1];
      if (next && !/^REPORT: Failed:/.test(next.text)) payloadDone = true;
    } else if ((match = /^verify: health commit (\S+), startup (\S+)/.exec(text))) {
      if (!reached.has("restart")) reached.set("restart", null);
      if (!reached.has("verify")) reached.set("verify", null);
      result.verifiedOk = match[2] === "logged";
    } else if (/^(upgrade failed verification; rolling back|busy at restart time)/.test(text)) {
      result.rollbackAt = at;
    } else if ((match = /^REPORT: Failed: install/.exec(text))) {
      result.failedStage = "download_build";
    }
  }
  const lastLineIsInstalling = installingAt !== null && attempt.lines[attempt.lines.length - 1]?.at === installingAt;
  if (lastLineIsInstalling && attempt.rawAfter.some((line) => /(Installed|Activated cached) paperclipai git payload/.test(line))) {
    payloadDone = true;
  }
  if (payloadDone && !reached.has("restart")) reached.set("restart", null);
  // Staple came back after the install began, on the target if both are known: the restart is
  // done and the installer is verifying.
  const serverMs = live?.serverStartedAt ? Date.parse(live.serverStartedAt) : NaN;
  const onTarget = !live?.installedNow || !result.target
    || live.installedNow.startsWith(result.target) || result.target.startsWith(live.installedNow);
  if (installingAt && onTarget && Number.isFinite(serverMs) && serverMs > Date.parse(installingAt)) {
    if (!reached.has("restart")) reached.set("restart", null);
    if (!reached.has("verify")) reached.set("verify", new Date(serverMs).toISOString());
    else if (reached.get("verify") === null) reached.set("verify", new Date(serverMs).toISOString());
  }
  return result;
}

function currentStage(progress: Progress): StapleConsoleUpgradeStageKey | null {
  let last: StapleConsoleUpgradeStageKey | null = null;
  for (const key of STAPLE_UPGRADE_STAGES) if (progress.reached.has(key)) last = key;
  return last;
}

function stageCells(
  progress: Progress,
  stage: StapleConsoleUpgradeStageKey | "rollback" | null,
  terminal: Terminal | null,
): StapleConsoleUpgradeStageCell[] {
  // A rollback happens after verification failed. A stage the attempt failed at is where it stopped.
  const pointer = stage === "rollback" ? "verify" : progress.failedStage ?? stage;
  const stageIndex = pointer ? STAPLE_UPGRADE_STAGES.indexOf(pointer) : -1;
  return STAPLE_UPGRADE_STAGES.map((key, index) => {
    let state: StapleConsoleUpgradeStageState;
    if (terminal?.phase === "verified" || index < stageIndex) state = "done";
    else if (index > stageIndex) state = terminal ? "skipped" : "pending";
    else if (stage === "rollback" || progress.failedStage === key) state = "failed";
    else if (!terminal) state = "current";
    else if (terminal.phase === "failed" || terminal.phase === "rolled_back" || terminal.phase === "needs_ethan") state = "failed";
    else state = "skipped";
    return { key, label: STAPLE_UPGRADE_STAGE_LABELS[key], state, startedAt: progress.reached.get(key) ?? null };
  });
}

const HOLD_SLACK_MS = 5 * 60_000;

function holdBelongsTo(hold: StapleConsoleUpgradeHold, attempt: Attempt, terminal: Terminal) {
  const since = Date.parse(hold.since);
  if (!Number.isFinite(since) || since > Date.parse(terminal.at) + HOLD_SLACK_MS) return false;
  if (!attempt.quiet || since >= Date.parse(attempt.startedAt) - HOLD_SLACK_MS) return true;
  // A quiet attempt that went on to place the hold renewed the one already in place (renewal keeps
  // its start), so that hold is its own. One that stopped at its busy checks never touched it.
  return attempt.lines.some((line) => /^maintenance hold active since /.test(line.text));
}

function sortByStart(attempts: Attempt[]) {
  return [...attempts].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}

const INSTALL_PHASES = new Set(["verified", "failed", "rolled_back", "needs_ethan"]);

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function nextActionFor(
  phase: StapleConsoleUpgradePhase,
  stage: StapleConsoleUpgradeStageKey | "rollback" | null,
  input: StapleConsoleUpgradeInput,
  ctx: { target: string | null; installed: string | null; outcome: string | null },
): string | null {
  const nightly = input.nextNightlyAt ? "the 03:30 nightly attempt" : null;
  if (phase === "running") {
    switch (stage) {
      case "certification": return "Checks CI on the certified target, then holds new runs";
      case "draining": return input.hold
        ? `Parks still-running work at the drain deadline, then backs up`
        : "Waits for running work to finish, then backs up";
      case "backup": return `Installs ${ctx.target ?? "the target"} after the backup`;
      case "download_build": return "Restarts Staple when the build finishes";
      case "restart": return "Checks health and startup recovery";
      case "verify": return "Runs the smoke check, then releases held work";
      case "rollback": return `Restores ${ctx.installed ?? "the previous build"}, then releases held work`;
      default: return "Upgrade in progress";
    }
  }
  if (phase === "stale") {
    return input.hold ? "The hold lifts by itself at its expiry" : nightly ? `Next try: ${nightly}` : null;
  }
  if (phase === "waiting") {
    if (ctx.outcome && /CI still running/.test(ctx.outcome)) return "Retries at the next watcher check";
    if (ctx.outcome && /Busy|run\(s\)/.test(ctx.outcome)) return nightly ? `Retries at the next hourly check, or ${nightly}` : "Retries at the next hourly check";
    return nightly ? `Next try: ${nightly}` : null;
  }
  if (phase === "needs_ethan") return null;
  return nightly ? `Next check: ${nightly}` : null;
}

function headlineFor(phase: StapleConsoleUpgradePhase, ctx: {
  stage: StapleConsoleUpgradeStageKey | "rollback" | null;
  target: string | null;
  installed: string | null;
  outcome: string | null;
  holdOnly: boolean;
}): string {
  const to = ctx.target ? ` to ${ctx.target}` : "";
  const reason = ctx.outcome?.replace(/^(Waiting|Skipped|Failed):\s*/, "") ?? null;
  switch (phase) {
    case "running":
      if (ctx.holdOnly) return "Maintenance hold: draining before the upgrade";
      return `Upgrading${to} · ${STAPLE_UPGRADE_STAGE_LABELS[ctx.stage ?? "certification"]}`;
    case "stale": return `Upgrade${to} not reporting`;
    case "waiting": return `Waiting · ${reason ?? "upgrade deferred"}`;
    case "up_to_date": return "Up to date";
    case "verified": return ctx.target ? `Installed ${ctx.target}, verified` : "Installed, verified";
    case "skipped": return `Didn't install · ${reason ?? "stopped before installing"}`;
    case "failed": return `Upgrade${to} failed · still on ${ctx.installed ?? "the previous build"}`;
    case "rolled_back": return `Rolled back · back on ${ctx.installed ?? "the previous build"}`;
    case "needs_ethan": return "Upgrade and rollback both failed";
    default: return "Upgrade status unknown";
  }
}

/** Build the upgrade card from the installer log, the hold record and the running build. */
export function buildStapleConsoleUpgradeStatus(input: StapleConsoleUpgradeInput): StapleConsoleUpgradeStatus {
  const nowMs = Date.parse(input.now);
  const installedNow = SHORT(input.installedBuild);
  const base = (overrides: Partial<StapleConsoleUpgradeStatus>): StapleConsoleUpgradeStatus => ({
    phase: "unknown",
    headline: "Upgrade status unknown",
    quiet: false,
    attemptStartedAt: null,
    attemptEndedAt: null,
    stage: null,
    stageStartedAt: null,
    stages: [],
    installed: installedNow,
    target: null,
    master: null,
    lastOutputAt: null,
    drainRunning: null,
    download: null,
    outcome: null,
    nextAction: null,
    needsEthan: null,
    hold: input.hold,
    lastInstall: null,
    source: { available: input.logs !== null, detail: "installer log", logName: null },
    ...overrides,
  });

  const attempts = sortByStart((input.logs ?? []).flatMap((file) => parseAttempts(file, input.timeZone)).filter((attempt) => !attempt.dry));
  const upgrades = attempts.filter((attempt) => attempt.kind === "upgrade" && !attempt.startUnread);

  let lastInstall: StapleConsoleUpgradeStatus["lastInstall"] = null;
  for (const attempt of [...upgrades].reverse()) {
    const terminal = terminalOf(attempt);
    if (terminal && INSTALL_PHASES.has(terminal.phase)) {
      const progress = progressOf(attempt, null);
      lastInstall = {
        phase: terminal.phase as "verified" | "failed" | "rolled_back" | "needs_ethan",
        at: terminal.at,
        from: progress.installed,
        to: progress.target,
      };
      break;
    }
  }

  const latest = upgrades[upgrades.length - 1] ?? null;
  const latestHold = [...attempts].reverse().find((attempt) => attempt.kind === "hold") ?? null;

  if (input.logs === null && !input.hold) {
    return base({ source: { available: false, detail: "installer log not readable", logName: null } });
  }

  // The newest output belongs to an attempt whose start is too far back in its log to read: which
  // attempt it is, and what it is doing, is unknown. Never pin that output on an older attempt.
  const newest = attempts[attempts.length - 1] ?? null;
  if (newest?.startUnread && newest.isLastInFile) {
    return base({
      headline: "Upgrade status unknown · installer log too long to read",
      lastOutputAt: newest.modifiedAt,
      hold: input.hold,
      lastInstall,
      source: { available: true, detail: "installer log too long; the current attempt's start wasn't read", logName: newest.logName },
    });
  }

  // An open attempt: no terminal line yet.
  const latestTerminal = latest ? terminalOf(latest) : null;
  if (latest && !latestTerminal) {
    const progress = progressOf(latest, { serverStartedAt: input.serverStartedAt, installedNow });
    const stage: StapleConsoleUpgradeStageKey | "rollback" | null = progress.rollbackAt ? "rollback" : currentStage(progress);
    const lastOutputAt = latest.isLastInFile ? latest.modifiedAt : latest.lines[latest.lines.length - 1]?.at ?? latest.startedAt;
    const staleAfter = stage === "download_build" ? STAPLE_UPGRADE_BUILD_STALE_MS : STAPLE_UPGRADE_STALE_MS;
    const stale = !Number.isFinite(Date.parse(lastOutputAt)) || nowMs - Date.parse(lastOutputAt) > staleAfter;
    const phase: StapleConsoleUpgradePhase = stale ? "stale" : "running";
    const stageStartedAt = stage === "rollback" ? progress.rollbackAt : stage ? progress.reached.get(stage) ?? null : null;
    const ctx = { stage, target: progress.target, installed: progress.installed ?? installedNow, outcome: null, holdOnly: false };
    return base({
      phase,
      headline: headlineFor(phase, ctx),
      quiet: latest.quiet,
      attemptStartedAt: latest.startedAt,
      stage,
      stageStartedAt,
      stages: stageCells(progress, stage, null),
      installed: installedNow ?? progress.installed,
      target: progress.target,
      master: progress.master,
      lastOutputAt,
      drainRunning: stage === "draining" ? progress.drainRunning : null,
      download: stage === "download_build" ? { bytes: null, totalBytes: null } : null,
      nextAction: nextActionFor(phase, stage, input, ctx),
      lastInstall,
      source: { available: true, detail: "installer log", logName: latest.logName },
    });
  }

  // The nightly hold is placed at 02:30, an hour before the upgrade run: the window is draining.
  // A hold still active after the latest attempt ended, placed before or during it, is that
  // attempt's (a release that failed, or NEEDS ETHAN, where it lifts at its expiry): the result
  // wins and the hold shows beside it. A quiet-window check doesn't own a hold it found in place
  // unless it went on to renew it.
  if (input.hold && !(latest && latestTerminal && holdBelongsTo(input.hold, latest, latestTerminal))) {
    const holdAttempt = latestHold && Date.parse(latestHold.startedAt) <= Date.parse(input.hold.since) + 5 * 60_000
      && Date.parse(latestHold.startedAt) >= Date.parse(input.hold.since) - 5 * 60_000 ? latestHold : null;
    const target = holdAttempt?.lines.map((line) => /^certified target: target:([0-9a-f]{7,40})/.exec(line.text)?.[1]).find(Boolean) ?? null;
    const ctx = { stage: "draining" as const, target: SHORT(target), installed: installedNow, outcome: null, holdOnly: true };
    return base({
      phase: "running",
      headline: headlineFor("running", ctx),
      attemptStartedAt: input.hold.since,
      stage: "draining",
      stageStartedAt: input.hold.since,
      stages: STAPLE_UPGRADE_STAGES.map((key) => ({
        key,
        label: STAPLE_UPGRADE_STAGE_LABELS[key],
        state: key === "certification" ? "done" : key === "draining" ? "current" : "pending",
        startedAt: key === "draining" ? input.hold!.since : null,
      })),
      target: SHORT(target),
      lastOutputAt: holdAttempt ? holdAttempt.lines[holdAttempt.lines.length - 1]?.at ?? holdAttempt.startedAt : null,
      drainRunning: input.hold.runningRuns,
      nextAction: input.nextNightlyAt ? "Parks still-running work at the drain deadline; the upgrade starts at 03:30" : "Parks still-running work at the drain deadline",
      lastInstall,
      source: { available: input.logs !== null, detail: input.logs !== null ? "installer log + hold record" : "hold record; installer log not readable", logName: holdAttempt?.logName ?? null },
    });
  }

  if (!latest || !latestTerminal) {
    return base({
      headline: input.logs && input.logs.length > 0 ? "No upgrade attempt recorded" : "No installer log yet",
      nextAction: input.nextNightlyAt ? "Next check: the 03:30 nightly attempt" : null,
      lastInstall,
      source: { available: input.logs !== null, detail: "installer log", logName: null },
    });
  }

  const progress = progressOf(latest, null);
  const phase = latestTerminal.phase;
  const reachedStage = currentStage(progress);
  // The live build is the truth for "installed"; the log's build names what a rollback returned to.
  const installed = installedNow ?? (phase === "verified" ? progress.target : progress.installed);
  const ctx = { stage: reachedStage, target: progress.target, installed: progress.installed ?? installedNow, outcome: latestTerminal.text, holdOnly: false };
  return base({
    phase,
    headline: headlineFor(phase, ctx),
    quiet: latest.quiet,
    attemptStartedAt: latest.startedAt,
    attemptEndedAt: latestTerminal.at,
    stage: reachedStage,
    stageStartedAt: reachedStage ? progress.reached.get(reachedStage) ?? null : null,
    // A check that never left certification has no stages worth a strip.
    stages: phase === "up_to_date" || (phase === "waiting" && reachedStage === "certification") ? [] : stageCells(progress, reachedStage, latestTerminal),
    installed,
    target: progress.target,
    master: progress.master,
    lastOutputAt: latestTerminal.at,
    outcome: latestTerminal.text,
    nextAction: input.hold && phase !== "needs_ethan" ? "The hold lifts by itself at its expiry" : nextActionFor(phase, reachedStage, input, ctx),
    needsEthan: phase === "needs_ethan"
      ? "Staple may be unhealthy after a failed upgrade and rollback. Check the service, and restore the pre-upgrade backup if the database changed."
      : null,
    lastInstall: lastInstall && lastInstall.at === latestTerminal.at ? null : lastInstall,
    source: { available: true, detail: "installer log", logName: latest.logName },
  });
}

export function stapleUpgradeDrainText(running: number | null) {
  if (running === null) return null;
  return running === 0 ? "Nothing running" : `${plural(running, "run")} still finishing`;
}
