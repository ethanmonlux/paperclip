/**
 * Staple Console: a read-only founder status board derived from Paperclip's own
 * issues, blockers, runs, interactions, approvals and work products (FAC-620).
 *
 * This module is pure. The server loads rows, converts them to the input shapes
 * below and calls `buildStapleConsoleBoard`; the UI only renders the result.
 * Nothing here writes, schedules or approves anything.
 */

export const STAPLE_CONSOLE_STEPS = ["queued", "build", "ci", "review", "merged"] as const;
export type StapleConsoleStep = (typeof STAPLE_CONSOLE_STEPS)[number];

export type StapleConsoleLaneKey =
  | "ember_vault"
  | "account"
  | "launcher"
  | "updates"
  | "convergence"
  | "staple"
  | "other";

export type StapleConsoleBetaTag = "beta" | "beta_preview" | "after_beta";

export interface StapleConsoleLane {
  key: StapleConsoleLaneKey;
  label: string;
  /** Repository used to resolve a bare "PR #N" in a task title. */
  defaultRepo: string | null;
}

export const STAPLE_CONSOLE_LANES: readonly StapleConsoleLane[] = [
  { key: "ember_vault", label: "Ember Vault", defaultRepo: "ethanmonlux/facette" },
  { key: "account", label: "Account journey", defaultRepo: "ethanmonlux/facette" },
  { key: "launcher", label: "Launcher", defaultRepo: "ethanmonlux/facette" },
  { key: "updates", label: "Updates and delivery", defaultRepo: "ethanmonlux/facette" },
  { key: "convergence", label: "Convergence", defaultRepo: "ethanmonlux/facette" },
  { key: "staple", label: "Staple", defaultRepo: "ethanmonlux/paperclip" },
  { key: "other", label: "Not in the lane map", defaultRepo: null },
];

export interface StapleConsoleLaneMapEntry {
  fac: number;
  lane: StapleConsoleLaneKey;
  title: string;
  /** null means the FAC-50 lane map does not state a tag; the UI shows "tag not set". */
  tag: StapleConsoleBetaTag | null;
  /** FAC-50 owner or follow-on that should have a Staple task ("Up next, not queued"). */
  upNext: boolean;
}

/**
 * Free beta lane map, from FAC-50 (work order 2026-11-01 plus founder decisions of
 * 2026-11-08/09) and FAC-620. Tags are set only where Linear text supports them.
 * Edit this table when FAC-50 changes; it is the only hand-maintained input.
 */
export const STAPLE_CONSOLE_LANE_MAP: readonly StapleConsoleLaneMapEntry[] = [
  // Ember Vault
  { fac: 703, lane: "ember_vault", title: "Ember Vault Slayer Face", tag: "beta", upNext: true },
  { fac: 792, lane: "ember_vault", title: "Kaia in Ember Vault", tag: "beta", upNext: true },
  { fac: 831, lane: "ember_vault", title: "Kaia modular gear", tag: "beta", upNext: true },
  { fac: 749, lane: "ember_vault", title: "Verified item classes and combat levels", tag: null, upNext: true },
  { fac: 622, lane: "ember_vault", title: "Facette item-art grammar", tag: null, upNext: true },
  { fac: 706, lane: "ember_vault", title: "Face blanking during teleports", tag: null, upNext: true },
  { fac: 705, lane: "ember_vault", title: "Session XP truth", tag: null, upNext: true },
  { fac: 794, lane: "ember_vault", title: "Dressed Kaia v1 source", tag: null, upNext: true },
  { fac: 798, lane: "ember_vault", title: "OSRS item catalog", tag: null, upNext: false },
  { fac: 799, lane: "ember_vault", title: "Slayer assignment catalog", tag: null, upNext: false },
  { fac: 818, lane: "ember_vault", title: "Item art and centred backpack slots", tag: null, upNext: true },
  { fac: 828, lane: "ember_vault", title: "Slayer boss and area names", tag: null, upNext: true },
  { fac: 830, lane: "ember_vault", title: "Item art trees", tag: null, upNext: true },
  // Account journey
  { fac: 832, lane: "account", title: "Self-serve accounts on facette.gg", tag: "beta", upNext: true },
  { fac: 612, lane: "account", title: "facette.gg customer journey", tag: "beta", upNext: true },
  { fac: 341, lane: "account", title: "Exact-user live sign-in proof", tag: null, upNext: true },
  { fac: 125, lane: "account", title: "Account lifecycle", tag: null, upNext: true },
  { fac: 370, lane: "account", title: "Production Free account readiness", tag: null, upNext: true },
  { fac: 751, lane: "account", title: "Account E2E and Windows launch", tag: null, upNext: false },
  { fac: 375, lane: "account", title: "Account E2E documentation", tag: null, upNext: false },
  { fac: 626, lane: "account", title: "Launcher to web account bridge", tag: null, upNext: true },
  { fac: 826, lane: "account", title: "Guided Account acceptance", tag: null, upNext: true },
  { fac: 541, lane: "account", title: "Development website", tag: null, upNext: false },
  // Launcher
  { fac: 752, lane: "launcher", title: "OSRS-only launcher and RuneLite onboarding", tag: "beta", upNext: true },
  { fac: 672, lane: "launcher", title: "App shell visual and UX refresh", tag: null, upNext: true },
  { fac: 677, lane: "launcher", title: "Platform shell prototype", tag: null, upNext: false },
  // Updates and delivery
  { fac: 829, lane: "updates", title: "Content packs without reinstall", tag: null, upNext: true },
  // Convergence
  { fac: 220, lane: "convergence", title: "Windows physical validation queue", tag: null, upNext: true },
  { fac: 297, lane: "convergence", title: "Existing users get correct game packs", tag: null, upNext: true },
  { fac: 298, lane: "convergence", title: "Clean external-user Plugin Hub path", tag: null, upNext: true },
  { fac: 267, lane: "convergence", title: "Candidate security pass", tag: null, upNext: true },
  { fac: 698, lane: "convergence", title: "Site security findings", tag: null, upNext: true },
  { fac: 660, lane: "convergence", title: "Legal, privacy and disclosure", tag: null, upNext: true },
  { fac: 50, lane: "convergence", title: "Free beta go/no-go", tag: null, upNext: false },
  // Staple (internal factory work, no beta tag)
  { fac: 597, lane: "staple", title: "Founder notifications", tag: null, upNext: false },
  { fac: 620, lane: "staple", title: "Staple Console", tag: null, upNext: false },
  { fac: 760, lane: "staple", title: "Task continuity and runtime repair", tag: null, upNext: false },
  { fac: 795, lane: "staple", title: "Workflow Repair team", tag: null, upNext: false },
  { fac: 796, lane: "staple", title: "Oversight and recovery", tag: null, upNext: false },
  { fac: 797, lane: "staple", title: "Managed updates", tag: null, upNext: false },
  { fac: 611, lane: "staple", title: "Branch-isolated development", tag: null, upNext: false },
  { fac: 709, lane: "staple", title: "Provider exit causes", tag: null, upNext: false },
  { fac: 810, lane: "staple", title: "Independent visual review", tag: null, upNext: false },
  { fac: 800, lane: "staple", title: "Hosted heavy builds", tag: null, upNext: false },
  // Albion follows the first OSRS beta
  { fac: 667, lane: "other", title: "First Albion player experience", tag: "after_beta", upNext: false },
  { fac: 668, lane: "other", title: "Albion connector and Face wiring", tag: "after_beta", upNext: false },
  { fac: 738, lane: "other", title: "Albion physical validation", tag: "after_beta", upNext: false },
  { fac: 740, lane: "other", title: "Albion acquisition and session repair", tag: "after_beta", upNext: false },
];

export const STAPLE_CONSOLE_THRESHOLDS = {
  inProgressIdleMs: 30 * 60_000,
  longRunMs: 90 * 60_000,
  reviewIdleMs: 2 * 60 * 60_000,
  repeatedFailureCount: 3,
} as const;

export const STAPLE_CONSOLE_TIME_ZONE = "America/Denver";

// ---------------------------------------------------------------------------
// Inputs (ISO timestamps; the server converts DB rows)

export interface StapleConsoleIssueInput {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  status: string;
  parentId: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  /** Scheduled monitor wake (issues.monitor_next_check_at). */
  monitorNextCheckAt: string | null;
  /** executionState.monitor.serviceName while that monitor is not cleared. */
  monitorServiceName?: string | null;
  monitorTriggeredAt?: string | null;
}

export interface StapleConsoleAgentInput {
  id: string;
  name: string;
  role: string | null;
}

export interface StapleConsoleRelationInput {
  blockerIssueId: string;
  blockedIssueId: string;
}

export interface StapleConsoleRunInput {
  id: string;
  issueId: string;
  agentId: string;
  status: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastOutputAt: string | null;
  errorCode: string | null;
  error: string | null;
}

export interface StapleConsoleWakeInput {
  issueId: string;
  status: string;
  requestedAt: string;
}

export interface StapleConsoleInteractionInput {
  id: string;
  issueId: string;
  kind: string;
  status: string;
  question: string;
  addresseeAgentId: string | null;
  createdAt: string;
}

export interface StapleConsoleApprovalInput {
  id: string;
  issueId: string;
  type: string;
  status: string;
  title: string;
  createdAt: string;
}

export type StapleConsoleCiState = "pending" | "success" | "failure" | "none" | "unknown";
export type StapleConsolePrState = "open" | "draft" | "merged" | "closed" | "unknown";

export interface StapleConsolePullRequestInput {
  issueId: string;
  repo: string;
  number: number;
  url: string;
  state: StapleConsolePrState;
  mergedAt: string | null;
  ci: StapleConsoleCiState;
  ciStartedAt: string | null;
  /** Where PR state came from: live GitHub read, a Paperclip work product, or only a title reference. */
  source: "github" | "work_product" | "reference";
}

export interface StapleConsoleScheduledEvent {
  label: string;
  at: string | null;
  detail: string | null;
  source: string;
  available: boolean;
}

export interface StapleConsoleSourceStatus {
  github: { available: boolean; detail: string };
}

export interface StapleConsoleInput {
  now: string;
  issuePrefix: string;
  issues: StapleConsoleIssueInput[];
  agents: StapleConsoleAgentInput[];
  relations: StapleConsoleRelationInput[];
  runs: StapleConsoleRunInput[];
  wakes: StapleConsoleWakeInput[];
  interactions: StapleConsoleInteractionInput[];
  approvals: StapleConsoleApprovalInput[];
  pullRequests: StapleConsolePullRequestInput[];
  scheduled: StapleConsoleScheduledEvent[];
  sources: StapleConsoleSourceStatus;
}

// ---------------------------------------------------------------------------
// Output

export type StapleConsoleStuckRule =
  | "in_progress_idle"
  | "long_run"
  | "blocked_without_blocker"
  | "review_idle"
  | "repeated_failure";

export interface StapleConsoleStuckFlag {
  rule: StapleConsoleStuckRule;
  issueIdentifier: string;
  reason: string;
}

export interface StapleConsoleNeedsEthan {
  issueIdentifier: string;
  question: string;
  /** Company-relative link to the existing answer surface, e.g. `/issues/STA-1#interaction-…`. */
  href: string;
  kind: "interaction" | "approval" | "assigned_to_user";
}

export interface StapleConsoleWaitingChip {
  issueIdentifier: string;
  title: string;
  status: string;
  /** Card that contains the blocking task, when it is on the board. */
  cardId: string | null;
}

export interface StapleConsoleMember {
  identifier: string;
  title: string;
  status: string;
  role: "coordinator" | "build" | "review";
  assigneeName: string | null;
}

export interface StapleConsoleCardPullRequest {
  label: string;
  url: string;
  state: StapleConsolePrState;
  ci: StapleConsoleCiState;
  source: StapleConsolePullRequestInput["source"];
}

export interface StapleConsoleStepCell {
  step: StapleConsoleStep;
  state: "done" | "current" | "todo";
  /** Current round on the current build/ci/review step; completed review rounds on Review. */
  rounds: number | null;
}

export interface StapleConsoleCard {
  id: string;
  identifier: string;
  title: string;
  status: string;
  lane: StapleConsoleLaneKey;
  laneSource: string;
  betaTag: StapleConsoleBetaTag | null;
  facIds: number[];
  step: StapleConsoleStep;
  round: number;
  steps: StapleConsoleStepCell[];
  stepSince: string | null;
  lastActivityAt: string | null;
  currentRunStartedAt: string | null;
  currentRunAgentName: string | null;
  members: StapleConsoleMember[];
  pullRequests: StapleConsoleCardPullRequest[];
  waitingOn: StapleConsoleWaitingChip[];
  stuck: StapleConsoleStuckFlag[];
  needsEthan: StapleConsoleNeedsEthan[];
  mergedToday: boolean;
}

export interface StapleConsoleUpNext {
  fac: number;
  title: string;
  lane: StapleConsoleLaneKey;
  tag: StapleConsoleBetaTag | null;
  /** A beta-tagged FAC-50 item with no Staple task. */
  betaGap: boolean;
}

export interface StapleConsoleBoard {
  generatedAt: string;
  issuePrefix: string;
  header: { mergedToday: number; inFlight: number; needsEthan: number; stuck: number };
  scheduled: StapleConsoleScheduledEvent[];
  lanes: Array<{ key: StapleConsoleLaneKey; label: string; cards: StapleConsoleCard[] }>;
  upNext: StapleConsoleUpNext[];
  sources: StapleConsoleSourceStatus;
}

// ---------------------------------------------------------------------------
// Helpers

const TERMINAL_STATUSES = new Set(["done", "cancelled"]);
const ACTIVE_RUN_STATUSES = new Set(["running"]);
const PENDING_RUN_STATUSES = new Set(["queued", "scheduled_retry"]);
const FAILED_RUN_STATUSES = new Set(["failed", "timed_out"]);
const PENDING_WAKE_STATUSES = new Set(["queued", "deferred_issue_execution"]);

export function isStapleConsoleTerminal(status: string) {
  return TERMINAL_STATUSES.has(status);
}

function ms(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function latest(values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const value of values) {
    const parsed = ms(value);
    if (parsed !== null && parsed > bestMs) {
      best = value!;
      bestMs = parsed;
    }
  }
  return best;
}

function earliest(values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  let bestMs = Infinity;
  for (const value of values) {
    const parsed = ms(value);
    if (parsed !== null && parsed < bestMs) {
      best = value!;
      bestMs = parsed;
    }
  }
  return best;
}

export function formatStapleConsoleDuration(durationMs: number): string {
  const minutes = Math.max(0, Math.floor(durationMs / 60_000));
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours} h ${rest} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days} d ${restHours} h` : `${days} d`;
}

const FAC_PATTERN = /\bFAC-(\d+)\b/g;

export function extractFacIds(text: string | null | undefined): number[] {
  if (!text) return [];
  const ids: number[] = [];
  for (const match of text.matchAll(FAC_PATTERN)) {
    const id = Number(match[1]);
    if (!ids.includes(id)) ids.push(id);
  }
  // "FAC-798/799" names two outcomes.
  for (const match of text.matchAll(/\bFAC-\d+\/(\d+)\b/g)) {
    const id = Number(match[1]);
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Day boundary in the founder's time zone, so "merged today" matches his clock. */
export function stapleConsoleDayKey(iso: string, timeZone = STAPLE_CONSOLE_TIME_ZONE): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(iso));
}

function isCoordinatorAgent(agent: StapleConsoleAgentInput | undefined) {
  if (!agent) return false;
  return agent.role === "general" || /coordinator|master builder/i.test(agent.name);
}

function isReviewIssue(issue: StapleConsoleIssueInput, agent: StapleConsoleAgentInput | undefined) {
  if (/\b(review|verify|verification)\b/i.test(issue.title)) return true;
  if (!agent) return false;
  return agent.role === "qa" || /reviewer/i.test(agent.name);
}

function lastRunActivity(run: StapleConsoleRunInput): string | null {
  return latest([run.lastOutputAt, run.finishedAt, run.startedAt, run.createdAt]);
}

// ---------------------------------------------------------------------------
// Stuck rules (each is exported so tests can pin it individually)

interface IssueRunContext {
  issue: StapleConsoleIssueInput;
  runs: StapleConsoleRunInput[]; // newest first
  wakes: StapleConsoleWakeInput[];
  openBlockerCount: number;
  pendingQuestionCount: number;
  isReview: boolean;
}

function activeRunOf(runs: StapleConsoleRunInput[]) {
  return runs.find((run) => ACTIVE_RUN_STATUSES.has(run.status)) ?? null;
}

function lastActivityOf(ctx: IssueRunContext): string | null {
  return latest(ctx.runs.map(lastRunActivity));
}

function hasScheduledWake(ctx: IssueRunContext) {
  if (ctx.issue.monitorNextCheckAt) return true;
  if (ctx.runs.some((run) => PENDING_RUN_STATUSES.has(run.status))) return true;
  return ctx.wakes.some((wake) => PENDING_WAKE_STATUSES.has(wake.status));
}

export function stuckInProgressIdle(ctx: IssueRunContext, nowMs: number): StapleConsoleStuckFlag | null {
  if (ctx.issue.status !== "in_progress") return null;
  if (activeRunOf(ctx.runs) || hasScheduledWake(ctx)) return null;
  const since = lastActivityOf(ctx) ?? ctx.issue.startedAt ?? ctx.issue.updatedAt;
  const sinceMs = ms(since);
  if (sinceMs === null || nowMs - sinceMs <= STAPLE_CONSOLE_THRESHOLDS.inProgressIdleMs) return null;
  return {
    rule: "in_progress_idle",
    issueIdentifier: ctx.issue.identifier,
    reason: `In progress, no run for ${formatStapleConsoleDuration(nowMs - sinceMs)} and no wake scheduled`,
  };
}

export function stuckLongRun(ctx: IssueRunContext, nowMs: number): StapleConsoleStuckFlag | null {
  const run = activeRunOf(ctx.runs);
  const startedMs = ms(run?.startedAt ?? null);
  if (!run || startedMs === null || nowMs - startedMs <= STAPLE_CONSOLE_THRESHOLDS.longRunMs) return null;
  return {
    rule: "long_run",
    issueIdentifier: ctx.issue.identifier,
    reason: `One run going for ${formatStapleConsoleDuration(nowMs - startedMs)}`,
  };
}

export function stuckBlockedWithoutBlocker(ctx: IssueRunContext): StapleConsoleStuckFlag | null {
  if (ctx.issue.status !== "blocked") return null;
  if (ctx.openBlockerCount > 0 || ctx.pendingQuestionCount > 0) return null;
  return {
    rule: "blocked_without_blocker",
    issueIdentifier: ctx.issue.identifier,
    reason: "Blocked, but no open blocker and no pending question",
  };
}

export function stuckReviewIdle(ctx: IssueRunContext, nowMs: number): StapleConsoleStuckFlag | null {
  if (!ctx.isReview || isStapleConsoleTerminal(ctx.issue.status)) return null;
  if (activeRunOf(ctx.runs) || ctx.runs.some((run) => PENDING_RUN_STATUSES.has(run.status))) return null;
  const openedMs = ms(ctx.issue.createdAt);
  if (openedMs === null || nowMs - openedMs <= STAPLE_CONSOLE_THRESHOLDS.reviewIdleMs) return null;
  const lastMs = ms(lastActivityOf(ctx));
  if (lastMs !== null && nowMs - lastMs <= STAPLE_CONSOLE_THRESHOLDS.reviewIdleMs) return null;
  const opened = formatStapleConsoleDuration(nowMs - openedMs);
  return {
    rule: "review_idle",
    issueIdentifier: ctx.issue.identifier,
    reason: lastMs === null
      ? `Review open ${opened} and no run yet`
      : `Review open ${opened}, no run for ${formatStapleConsoleDuration(nowMs - lastMs)}`,
  };
}

function failureSignature(run: StapleConsoleRunInput) {
  if (run.errorCode) return run.errorCode;
  const firstLine = (run.error ?? "").split("\n")[0]!.trim();
  return firstLine ? firstLine.slice(0, 160) : run.status;
}

export function stuckRepeatedFailure(ctx: IssueRunContext): StapleConsoleStuckFlag | null {
  if (isStapleConsoleTerminal(ctx.issue.status)) return null;
  const finished = ctx.runs.filter((run) => !ACTIVE_RUN_STATUSES.has(run.status) && !PENDING_RUN_STATUSES.has(run.status));
  const count = STAPLE_CONSOLE_THRESHOLDS.repeatedFailureCount;
  const recent = finished.slice(0, count);
  if (recent.length < count || !recent.every((run) => FAILED_RUN_STATUSES.has(run.status))) return null;
  const signature = failureSignature(recent[0]!);
  if (!recent.every((run) => failureSignature(run) === signature)) return null;
  return {
    rule: "repeated_failure",
    issueIdentifier: ctx.issue.identifier,
    reason: `Same failure ${count} times in a row: ${signature}`,
  };
}

export function evaluateStapleConsoleStuckRules(ctx: IssueRunContext, nowMs: number): StapleConsoleStuckFlag[] {
  return [
    stuckInProgressIdle(ctx, nowMs),
    stuckLongRun(ctx, nowMs),
    stuckBlockedWithoutBlocker(ctx),
    stuckReviewIdle(ctx, nowMs),
    stuckRepeatedFailure(ctx),
  ].filter((flag): flag is StapleConsoleStuckFlag => flag !== null);
}

export type StapleConsoleIssueRunContext = IssueRunContext;

// ---------------------------------------------------------------------------
// Board

interface Workstream {
  root: StapleConsoleIssueInput;
  members: StapleConsoleIssueInput[]; // root first
}

/**
 * One workstream per coordinator issue (or top-level issue) with its implementation
 * and review descendants. A parentless task titled "STA-N | …" joins STA-N.
 */
function groupWorkstreams(
  issues: StapleConsoleIssueInput[],
  agentsById: Map<string, StapleConsoleAgentInput>,
): Workstream[] {
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const byIdentifier = new Map(issues.map((issue) => [issue.identifier, issue]));
  const effectiveParent = new Map<string, string | null>();
  for (const issue of issues) {
    let parentId = issue.parentId && byId.has(issue.parentId) ? issue.parentId : null;
    if (!parentId) {
      const ref = /^\s*([A-Z][A-Z0-9]*-\d+)\b/.exec(issue.title)?.[1];
      const target = ref ? byIdentifier.get(ref) : undefined;
      if (target && target.id !== issue.id) parentId = target.id;
    }
    effectiveParent.set(issue.id, parentId);
  }
  const isRoot = (issue: StapleConsoleIssueInput) =>
    !effectiveParent.get(issue.id) || isCoordinatorAgent(agentsById.get(issue.assigneeAgentId ?? ""));

  const rootOf = new Map<string, string>();
  for (const issue of issues) {
    let current: StapleConsoleIssueInput | undefined = issue;
    const seen = new Set<string>();
    while (current && !isRoot(current) && !seen.has(current.id)) {
      seen.add(current.id);
      current = byId.get(effectiveParent.get(current.id) ?? "");
    }
    rootOf.set(issue.id, current && !seen.has(current.id) ? current.id : issue.id);
  }

  const streams = new Map<string, Workstream>();
  for (const issue of issues) {
    if (!isRoot(issue)) continue;
    streams.set(issue.id, { root: issue, members: [issue] });
  }
  for (const issue of issues) {
    const rootId = rootOf.get(issue.id)!;
    if (rootId === issue.id) continue;
    streams.get(rootId)?.members.push(issue);
  }
  return [...streams.values()];
}

function ancestorsTitles(issue: StapleConsoleIssueInput, byId: Map<string, StapleConsoleIssueInput>) {
  const titles: string[] = [];
  const seen = new Set<string>();
  let current = issue.parentId ? byId.get(issue.parentId) : undefined;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    titles.push(current.title);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return titles;
}

function resolveLane(
  stream: Workstream,
  byId: Map<string, StapleConsoleIssueInput>,
  byIdentifier: Map<string, StapleConsoleIssueInput>,
) {
  const mapByFac = new Map(STAPLE_CONSOLE_LANE_MAP.map((entry) => [entry.fac, entry]));
  const titleRefs = (issue: StapleConsoleIssueInput) => {
    const ref = /^\s*([A-Z][A-Z0-9]*-\d+)\b/.exec(issue.title)?.[1];
    const target = ref ? byIdentifier.get(ref) : undefined;
    return target && target.id !== issue.id ? [target.title, ...ancestorsTitles(target, byId)] : [];
  };
  const candidates: Array<{ text: string; source: string }> = [
    { text: stream.root.title, source: `${stream.root.identifier} title` },
    ...ancestorsTitles(stream.root, byId).map((text) => ({ text, source: "parent title" })),
    ...titleRefs(stream.root).map((text) => ({ text, source: "referenced task title" })),
    ...stream.members.slice(1).map((issue) => ({ text: issue.title, source: `${issue.identifier} title` })),
  ];
  const facIds: number[] = [];
  for (const candidate of candidates) {
    for (const fac of extractFacIds(candidate.text)) if (!facIds.includes(fac)) facIds.push(fac);
  }
  for (const candidate of candidates) {
    for (const fac of extractFacIds(candidate.text)) {
      const entry = mapByFac.get(fac);
      if (entry) {
        return { lane: entry.lane, betaTag: entry.tag, facIds, laneSource: `FAC-${fac} via ${candidate.source}` };
      }
    }
  }
  if (facIds.length === 0) {
    return { lane: "staple" as const, betaTag: null, facIds, laneSource: "No FAC id: internal Staple work" };
  }
  return { lane: "other" as const, betaTag: null, facIds, laneSource: `FAC-${facIds[0]} is not in the lane map` };
}

function questionHref(identifier: string, interactionId?: string) {
  return interactionId ? `/issues/${identifier}#interaction-${interactionId}` : `/issues/${identifier}`;
}

export function buildStapleConsoleBoard(input: StapleConsoleInput): StapleConsoleBoard {
  const nowMs = Date.parse(input.now);
  const todayKey = stapleConsoleDayKey(input.now);
  const agentsById = new Map(input.agents.map((agent) => [agent.id, agent]));
  const issues = input.issues;
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const byIdentifier = new Map(issues.map((issue) => [issue.identifier, issue]));

  const runsByIssue = new Map<string, StapleConsoleRunInput[]>();
  for (const run of input.runs) {
    const list = runsByIssue.get(run.issueId) ?? [];
    list.push(run);
    runsByIssue.set(run.issueId, list);
  }
  for (const list of runsByIssue.values()) {
    list.sort((a, b) => (ms(b.createdAt) ?? 0) - (ms(a.createdAt) ?? 0));
  }
  const wakesByIssue = new Map<string, StapleConsoleWakeInput[]>();
  for (const wake of input.wakes) {
    wakesByIssue.set(wake.issueId, [...(wakesByIssue.get(wake.issueId) ?? []), wake]);
  }
  const blockersOf = new Map<string, StapleConsoleIssueInput[]>();
  for (const relation of input.relations) {
    const blocker = byId.get(relation.blockerIssueId);
    if (!blocker) continue;
    blockersOf.set(relation.blockedIssueId, [...(blockersOf.get(relation.blockedIssueId) ?? []), blocker]);
  }
  const pendingInteractions = input.interactions.filter((interaction) => interaction.status === "pending");
  const pendingApprovals = input.approvals.filter((approval) => approval.status === "pending");
  const prsByIssue = new Map<string, StapleConsolePullRequestInput[]>();
  for (const pr of input.pullRequests) {
    prsByIssue.set(pr.issueId, [...(prsByIssue.get(pr.issueId) ?? []), pr]);
  }

  const streams = groupWorkstreams(issues, agentsById);
  const cardIdOfIssue = new Map<string, string>();
  for (const stream of streams) for (const member of stream.members) cardIdOfIssue.set(member.id, stream.root.id);
  const childrenOf = new Map<string, StapleConsoleIssueInput[]>();
  for (const issue of issues) {
    if (!issue.parentId) continue;
    childrenOf.set(issue.parentId, [...(childrenOf.get(issue.parentId) ?? []), issue]);
  }

  const cards: StapleConsoleCard[] = [];
  for (const stream of streams) {
    const { root } = stream;
    const members = stream.members.filter((issue) => issue.status !== "cancelled");
    if (root.status === "cancelled") continue;
    const memberIds = new Set(members.map((issue) => issue.id));
    const reviewMembers = members.filter((issue) =>
      issue.id !== root.id && isReviewIssue(issue, agentsById.get(issue.assigneeAgentId ?? "")));
    const reviewIds = new Set(reviewMembers.map((issue) => issue.id));
    const buildMembers = members.filter((issue) => issue.id !== root.id && !reviewIds.has(issue.id));
    const cardPrs = members.flatMap((issue) => prsByIssue.get(issue.id) ?? []);
    const uniquePrs = new Map<string, StapleConsolePullRequestInput>();
    for (const pr of cardPrs) {
      const key = `${pr.repo.toLowerCase()}#${pr.number}`;
      const existing = uniquePrs.get(key);
      const rank = { github: 3, work_product: 2, reference: 1 } as const;
      if (!existing || rank[pr.source] > rank[existing.source]) uniquePrs.set(key, pr);
    }
    const prs = [...uniquePrs.values()].sort((a, b) => b.number - a.number);

    const memberRuns = members.flatMap((issue) => runsByIssue.get(issue.id) ?? []);
    const activeRun = memberRuns
      .filter((run) => ACTIVE_RUN_STATUSES.has(run.status))
      .sort((a, b) => (ms(a.startedAt) ?? 0) - (ms(b.startedAt) ?? 0))[0] ?? null;
    const lastActivityAt = latest(memberRuns.map(lastRunActivity));

    // ---- Step and round
    const doneReviews = reviewMembers.filter((issue) => issue.status === "done");
    const openReview = reviewMembers.find((issue) => !isStapleConsoleTerminal(issue.status)) ?? null;
    const lastReviewDoneAt = latest(doneReviews.map((issue) => issue.completedAt ?? issue.updatedAt));
    const lastReviewDoneMs = ms(lastReviewDoneAt);
    const buildRunStarts = [root, ...buildMembers].flatMap((issue) =>
      (runsByIssue.get(issue.id) ?? []).map((run) => run.startedAt ?? run.createdAt));
    const buildActivityAfterReview = lastReviewDoneMs !== null && (
      buildRunStarts.some((start) => (ms(start) ?? 0) > lastReviewDoneMs)
      || buildMembers.some((issue) => (ms(issue.createdAt) ?? 0) > lastReviewDoneMs)
    );
    const openBuild = buildMembers.filter((issue) => !isStapleConsoleTerminal(issue.status));
    const anyPrMerged = prs.some((pr) => pr.state === "merged");
    const openPr = prs.find((pr) => pr.state === "open" || pr.state === "draft") ?? null;
    const ciMonitor = members.find((issue) =>
      !isStapleConsoleTerminal(issue.status) && /github|actions|\bci\b/i.test(issue.monitorServiceName ?? ""));
    const buildRunActive = [root, ...buildMembers].some((issue) => activeRunOf(runsByIssue.get(issue.id) ?? []));

    let step: StapleConsoleStep;
    let stepSince: string | null;
    let round = doneReviews.length + (openReview ? 1 : 0);
    if (root.status === "done" || (anyPrMerged && !openReview && openBuild.length === 0)) {
      step = "merged";
      round = Math.max(1, doneReviews.length);
      stepSince = latest(prs.map((pr) => pr.mergedAt)) ?? root.completedAt;
    } else if (openReview) {
      step = "review";
      stepSince = openReview.startedAt ?? openReview.createdAt;
    } else if (doneReviews.length > 0 && !buildActivityAfterReview && openBuild.length === 0) {
      // Last review finished and nothing went back to Build: awaiting merge.
      step = "review";
      round = doneReviews.length;
      stepSince = lastReviewDoneAt;
    } else if (
      (ciMonitor || (openPr && openPr.ci === "pending")) && !buildRunActive
    ) {
      step = "ci";
      round = doneReviews.length + 1;
      stepSince = ciMonitor?.monitorTriggeredAt ?? openPr?.ciStartedAt
        ?? latest([root, ...buildMembers].flatMap((issue) => (runsByIssue.get(issue.id) ?? []).map((run) => run.finishedAt)));
    } else if (openBuild.length > 0 || openPr || buildRunActive || root.status === "in_progress") {
      step = "build";
      round = doneReviews.length + 1;
      stepSince = doneReviews.length > 0
        ? lastReviewDoneAt
        : earliest([...openBuild.map((issue) => issue.startedAt ?? issue.createdAt), root.startedAt]);
    } else {
      step = "queued";
      round = Math.max(1, round);
      stepSince = root.createdAt;
    }
    round = Math.max(1, round);
    const currentIndex = STAPLE_CONSOLE_STEPS.indexOf(step);
    const steps: StapleConsoleStepCell[] = STAPLE_CONSOLE_STEPS.map((cellStep, index) => ({
      step: cellStep,
      state: index < currentIndex ? "done" : index === currentIndex ? "current" : "todo",
      rounds: cellStep === step && (step === "build" || step === "ci" || step === "review")
        ? round
        : cellStep === "review" && doneReviews.length > 0
          ? doneReviews.length
          : null,
    }));

    // ---- Waiting chips, stuck flags, needs Ethan
    const waitingOn: StapleConsoleWaitingChip[] = [];
    const stuck: StapleConsoleStuckFlag[] = [];
    const needsEthan: StapleConsoleNeedsEthan[] = [];
    for (const member of members) {
      if (isStapleConsoleTerminal(member.status)) continue;
      const blockers = blockersOf.get(member.id) ?? [];
      const openBlockers = blockers.filter((blocker) => !isStapleConsoleTerminal(blocker.status));
      for (const blocker of openBlockers) {
        if (memberIds.has(blocker.id) || waitingOn.some((chip) => chip.issueIdentifier === blocker.identifier)) continue;
        waitingOn.push({
          issueIdentifier: blocker.identifier,
          title: blocker.title,
          status: blocker.status,
          cardId: cardIdOfIssue.get(blocker.id) ?? null,
        });
      }
      const openChildren = (childrenOf.get(member.id) ?? []).filter((child) => !isStapleConsoleTerminal(child.status));
      const questions = pendingInteractions.filter((interaction) =>
        interaction.issueId === member.id && !interaction.addresseeAgentId);
      const approvals = pendingApprovals.filter((approval) => approval.issueId === member.id);
      for (const interaction of questions) {
        needsEthan.push({
          issueIdentifier: member.identifier,
          question: interaction.question,
          href: questionHref(member.identifier, interaction.id),
          kind: "interaction",
        });
      }
      for (const approval of approvals) {
        needsEthan.push({
          issueIdentifier: member.identifier,
          question: approval.title,
          href: questionHref(member.identifier),
          kind: "approval",
        });
      }
      if (member.assigneeUserId) {
        needsEthan.push({
          issueIdentifier: member.identifier,
          question: member.title,
          href: questionHref(member.identifier),
          kind: "assigned_to_user",
        });
      }
      stuck.push(...evaluateStapleConsoleStuckRules({
        issue: member,
        runs: runsByIssue.get(member.id) ?? [],
        wakes: wakesByIssue.get(member.id) ?? [],
        // A coordinator waiting on its own open child tasks is a real wait.
        openBlockerCount: openBlockers.length + openChildren.length,
        pendingQuestionCount: questions.length + approvals.length + (member.assigneeUserId ? 1 : 0),
        isReview: reviewIds.has(member.id),
      }, nowMs));
    }

    const mergedAt = step === "merged" ? stepSince : null;
    const mergedToday = mergedAt !== null && stapleConsoleDayKey(mergedAt) === todayKey;
    // Show open workstreams and those merged today; older finished work is history.
    if (isStapleConsoleTerminal(root.status) && !mergedToday) continue;
    if (root.status === "backlog" && members.length === 1 && memberRuns.length === 0) continue;

    const lane = resolveLane(stream, byId, byIdentifier);
    const memberView = (issue: StapleConsoleIssueInput): StapleConsoleMember => ({
      identifier: issue.identifier,
      title: issue.title,
      status: issue.status,
      role: issue.id === root.id ? "coordinator" : reviewIds.has(issue.id) ? "review" : "build",
      assigneeName: agentsById.get(issue.assigneeAgentId ?? "")?.name ?? (issue.assigneeUserId ? "Ethan" : null),
    });
    cards.push({
      id: root.id,
      identifier: root.identifier,
      title: root.title,
      status: root.status,
      lane: lane.lane,
      laneSource: lane.laneSource,
      betaTag: lane.betaTag,
      facIds: lane.facIds,
      step,
      round,
      steps,
      stepSince,
      lastActivityAt,
      currentRunStartedAt: activeRun?.startedAt ?? null,
      currentRunAgentName: activeRun ? agentsById.get(activeRun.agentId)?.name ?? null : null,
      members: [root, ...members.filter((issue) => issue.id !== root.id)
        .sort((a, b) => (ms(a.createdAt) ?? 0) - (ms(b.createdAt) ?? 0))].map(memberView),
      pullRequests: prs.slice(0, 3).map((pr) => ({
        label: `${pr.repo.split("/")[1] ?? pr.repo}#${pr.number}`,
        url: pr.url,
        state: pr.state,
        ci: pr.ci,
        source: pr.source,
      })),
      waitingOn,
      stuck,
      needsEthan,
      mergedToday,
    });
  }

  // Coral first, then red, then most recent activity.
  cards.sort((a, b) =>
    Number(b.needsEthan.length > 0) - Number(a.needsEthan.length > 0)
    || Number(b.stuck.length > 0) - Number(a.stuck.length > 0)
    || Number(a.step === "merged") - Number(b.step === "merged")
    || (ms(b.lastActivityAt) ?? 0) - (ms(a.lastActivityAt) ?? 0));

  const referencedFacs = new Set<number>();
  for (const issue of issues) {
    if (issue.status === "cancelled") continue;
    for (const fac of extractFacIds(issue.title)) referencedFacs.add(fac);
  }
  const upNext: StapleConsoleUpNext[] = STAPLE_CONSOLE_LANE_MAP
    .filter((entry) => entry.upNext && !referencedFacs.has(entry.fac))
    .map((entry) => ({
      fac: entry.fac,
      title: entry.title,
      lane: entry.lane,
      tag: entry.tag,
      betaGap: entry.tag === "beta",
    }))
    .sort((a, b) => Number(b.betaGap) - Number(a.betaGap));

  const lanes = STAPLE_CONSOLE_LANES.map((lane) => ({
    key: lane.key,
    label: lane.label,
    cards: cards.filter((card) => card.lane === lane.key),
  })).filter((lane) => lane.cards.length > 0 || lane.key !== "other");

  return {
    generatedAt: input.now,
    issuePrefix: input.issuePrefix,
    header: {
      mergedToday: cards.filter((card) => card.mergedToday).length,
      inFlight: cards.filter((card) => card.step === "build" || card.step === "ci" || card.step === "review").length,
      needsEthan: cards.filter((card) => card.needsEthan.length > 0).length,
      stuck: cards.filter((card) => card.stuck.length > 0).length,
    },
    scheduled: input.scheduled,
    lanes,
    upNext,
    sources: input.sources,
  };
}

// ---------------------------------------------------------------------------
// Source helpers used by the server loader

/** Repository for a bare "PR #N": Staple work lives in the fork, product work in facette. */
export function stapleConsoleDefaultRepo(titles: string[]): string {
  const mapByFac = new Map(STAPLE_CONSOLE_LANE_MAP.map((entry) => [entry.fac, entry]));
  for (const title of titles) {
    for (const fac of extractFacIds(title)) {
      const entry = mapByFac.get(fac);
      if (entry) return STAPLE_CONSOLE_LANES.find((lane) => lane.key === entry.lane)?.defaultRepo ?? "ethanmonlux/facette";
    }
  }
  return titles.some((title) => extractFacIds(title).length > 0) ? "ethanmonlux/facette" : "ethanmonlux/paperclip";
}

export interface StapleConsolePrRef {
  repo: string;
  number: number;
  url: string;
}

/**
 * Full GitHub PR URLs anywhere in `text`; bare "PR #N" only in `title` (titles are
 * curated, descriptions often cite older PRs in other repositories).
 */
export function extractStapleConsolePrRefs(title: string, text: string | null | undefined, defaultRepo: string): StapleConsolePrRef[] {
  const refs = new Map<string, StapleConsolePrRef>();
  const add = (repo: string, number: number) => {
    const key = `${repo.toLowerCase()}#${number}`;
    if (!refs.has(key)) refs.set(key, { repo, number, url: `https://github.com/${repo}/pull/${number}` });
  };
  for (const source of [title, text ?? ""]) {
    for (const match of source.matchAll(/https:\/\/(?:www\.)?github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g)) {
      add(match[1]!, Number(match[2]));
    }
  }
  for (const match of title.matchAll(/\bPR ?#(\d+)\b/gi)) add(defaultRepo, Number(match[1]));
  return [...refs.values()];
}

function zonedParts(epochMs: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(epochMs));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

/** Next occurrence of a wall-clock time ("03:30") in `timeZone`, strictly after `nowIso`. */
export function nextStapleConsoleLocalTime(nowIso: string, hhmm: string, timeZone = STAPLE_CONSOLE_TIME_ZONE): string {
  const [hour, minute] = hhmm.split(":").map(Number) as [number, number];
  const nowMs = Date.parse(nowIso);
  const today = zonedParts(nowMs, timeZone);
  for (let dayOffset = 0; dayOffset <= 2; dayOffset += 1) {
    const naiveUtc = Date.UTC(today.year, today.month - 1, today.day + dayOffset, hour, minute);
    // Correct the naive guess by the zone offset at that instant (twice covers DST edges).
    let candidate = naiveUtc;
    for (let pass = 0; pass < 2; pass += 1) {
      const local = zonedParts(candidate, timeZone);
      const localAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
      candidate += naiveUtc - localAsUtc;
    }
    if (candidate > nowMs) return new Date(candidate).toISOString();
  }
  return new Date(nowMs + 24 * 60 * 60_000).toISOString();
}

// ---------------------------------------------------------------------------
// Freshness (used by the page; kept here so it is tested with the rules)

export const STAPLE_CONSOLE_POLL_MS = 30_000;
export const STAPLE_CONSOLE_STALE_MS = 2 * 60_000;

export function stapleConsoleFreshness(lastSuccessAt: number | null, nowMs: number) {
  if (lastSuccessAt === null) return { ageMs: null, stale: true, label: "Not loaded yet" };
  const ageMs = Math.max(0, nowMs - lastSuccessAt);
  const seconds = Math.floor(ageMs / 1000);
  const label = seconds < 60 ? `Updated ${seconds} s ago` : `Updated ${formatStapleConsoleDuration(ageMs)} ago`;
  return { ageMs, stale: ageMs > STAPLE_CONSOLE_STALE_MS, label };
}
