/**
 * Staple Console: a read-only founder status board derived from Paperclip's own
 * issues, blockers, runs, interactions, approvals and work products (FAC-620).
 *
 * This module is pure. The server loads rows, converts them to the input shapes
 * below and calls `buildStapleConsoleBoard`; the UI only renders the result.
 * Nothing here writes, schedules or approves anything.
 */

import {
  deriveStapleConsoleCapabilities,
  parseStapleConsoleCapabilityMap,
  type StapleConsoleCapabilityBoard,
  type StapleConsoleCapabilityMapDocumentInput,
  type StapleConsoleClaimTaskFacts,
  type StapleConsoleProofPullRequest,
  type StapleConsoleProofReview,
} from "./staple-console-capabilities.js";
import type { StapleConsoleUpgradeStatus } from "./staple-console-upgrade.js";

export * from "./staple-console-capabilities.js";
export * from "./staple-console-upgrade.js";

export const STAPLE_CONSOLE_STEPS = ["queued", "build", "ci", "review", "merged"] as const;
export type StapleConsoleStep = (typeof STAPLE_CONSOLE_STEPS)[number];
/** A card's step: one of the five bar steps, or "done" for task-only completion with no merge evidence (FAC-837). */
export type StapleConsoleCardStep = StapleConsoleStep | "done";

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
  /** A pushed PR head with zero check runs after this long means CI never started (FAC-840). */
  ciNotStartedMs: 10 * 60_000,
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
  /** Live wait-record kind (FAC-840): external_service, ci or pr_mergeable. */
  waitKind?: string | null;
  /** The server's latest reading of a ci / pr_mergeable wait, or its target. */
  waitDetail?: string | null;
  /** Agents in this task's own native review stage (FAC-838): their runs here are review, not correction. */
  reviewerAgentIds?: string[];
  /** This task's native review stage is waiting on its reviewer. */
  reviewStageActive?: boolean;
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
  /** Head commit, and its commit time when GitHub reports no check runs for it. */
  headSha?: string | null;
  headCommittedAt?: string | null;
  /** Where PR state came from: live GitHub read, a Paperclip work product, or only a title reference. */
  source: "github" | "work_product" | "reference";
  /** Merge commit of a merged PR, from GitHub. */
  mergeCommitSha?: string | null;
  /** The installed Staple build contains the merge commit; null when it cannot be told. */
  inInstalledBuild?: boolean | null;
}

export type StapleConsoleReviewOutcome = "approved" | "changes_requested";

/**
 * A recorded review verdict (FAC-838): a native execution-stage decision, or the reviewer's
 * own verdict comment on a review task. Rounds come only from these, never from task counts.
 */
export interface StapleConsoleReviewDecisionInput {
  issueId: string;
  outcome: StapleConsoleReviewOutcome;
  at: string;
  source: "execution_decision" | "verdict_comment";
  /** The reviewer agent that recorded it, when known. */
  reviewerAgentId?: string | null;
}

export interface StapleConsoleScheduledEvent {
  label: string;
  at: string | null;
  detail: string | null;
  source: string;
  available: boolean;
}

/** The newest comment on a task, for a card's expanded view. */
export interface StapleConsoleCommentInput {
  issueId: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  body: string;
  createdAt: string;
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
  /** PRs a capability claim names directly; their `issueId` is empty. */
  claimPullRequests?: StapleConsolePullRequestInput[];
  reviewDecisions?: StapleConsoleReviewDecisionInput[];
  scheduled: StapleConsoleScheduledEvent[];
  sources: StapleConsoleSourceStatus;
  /** Latest comment per task (any subset); cards show the newest among their tasks. */
  comments?: StapleConsoleCommentInput[];
  /** The `capability-map` document (Level 2), when one is readable. */
  capabilityMap?: StapleConsoleCapabilityMapDocumentInput | null;
  /** Short SHA of the installed Staple build. */
  installedBuild?: string | null;
}

// ---------------------------------------------------------------------------
// Output

export type StapleConsoleStuckRule =
  | "in_progress_idle"
  | "long_run"
  | "blocked_without_blocker"
  | "review_idle"
  | "repeated_failure"
  | "ci_not_started";

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
  mergedAt: string | null;
  mergeCommitSha: string | null;
  inInstalledBuild: boolean | null;
}

export interface StapleConsoleStepCell {
  step: StapleConsoleStep;
  /** "skipped": no evidence the step happened, e.g. Merged on a task finished without a merged PR. */
  state: "done" | "current" | "todo" | "skipped";
  /** Current round on the current build/ci/review step; decided review rounds on Review. */
  rounds: number | null;
}

/**
 * How finished work ended (FAC-837). "merged" needs PR merge evidence; "task_done" is a task
 * marked Done whose source is not confirmed integrated (open, closed, unknown or no PR).
 */
export type StapleConsoleCompletion = "merged" | "task_done";

export interface StapleConsoleCard {
  id: string;
  identifier: string;
  title: string;
  /** Plain feature name: the capability map's name, else the title without IDs and asides. */
  name: string;
  /** Who is on it now: the running agent, else the newest open task's assignee. */
  ownerName: string | null;
  /** Finished today (merged, or Done with no open PR): listed once under Shipped today. */
  shipped: boolean;
  /** The latest recorded review verdict (Level 4 proof). */
  review: { outcome: StapleConsoleReviewOutcome; reviewerName: string | null; at: string } | null;
  lastComment: { issueIdentifier: string; authorName: string | null; at: string; excerpt: string } | null;
  status: string;
  lane: StapleConsoleLaneKey;
  laneSource: string;
  betaTag: StapleConsoleBetaTag | null;
  facIds: number[];
  step: StapleConsoleCardStep;
  round: number;
  completion: StapleConsoleCompletion | null;
  /** Plain statement of a task-only completion, e.g. "Task done; paperclip#30 is still open, not merged". */
  completionNote: string | null;
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
  /** Confirmed PR merge today; task completion alone never counts. */
  mergedToday: boolean;
}

/**
 * Level 1 "Needs attention" (FAC-620 v2): stuck work, founder questions and Done work whose
 * PR nobody is merging. Empty means "Nothing needs you; nothing stalled."
 */
export interface StapleConsoleAttentionItem {
  kind: "needs_you" | "stuck" | "unowned_merge";
  cardId: string;
  identifier: string;
  name: string;
  /** The one-line question or reason. */
  text: string;
  href: string;
  linkLabel: string;
}

export interface StapleConsoleUpNext {
  fac: number;
  title: string;
  lane: StapleConsoleLaneKey;
  tag: StapleConsoleBetaTag | null;
  /** A beta-tagged FAC-50 item with no Staple task. */
  betaGap: boolean;
}

/** Active managed maintenance window (FAC-840 C1): admission is held, wakes queue. */
export interface StapleConsoleMaintenanceHold {
  since: string;
  drainDeadlineAt: string;
  expiresAt: string;
  queuedWakes: number;
  runningRuns: number;
  parkedRuns: number;
}

export interface StapleConsoleBoard {
  generatedAt: string;
  /** Present while the nightly maintenance hold is active. */
  maintenanceHold?: StapleConsoleMaintenanceHold | null;
  /** Managed upgrade card (FAC-620 upgrade status): stage, timing, hold and next action. */
  upgrade?: StapleConsoleUpgradeStatus | null;
  issuePrefix: string;
  header: { mergedToday: number; inFlight: number; needsEthan: number; stuck: number };
  scheduled: StapleConsoleScheduledEvent[];
  lanes: Array<{ key: StapleConsoleLaneKey; label: string; cards: StapleConsoleCard[] }>;
  attention: StapleConsoleAttentionItem[];
  capabilities: StapleConsoleCapabilityBoard;
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

/**
 * PR status text for a card link. Only a GitHub read is live; a Paperclip work-product status
 * can go stale, so it reads "recorded" with CI unknown (STA-205).
 */
export function stapleConsolePrStatusText(pr: Pick<StapleConsoleCardPullRequest, "state" | "ci" | "source">): string {
  // FAC-929: a state GitHub did not answer this refresh says so where it is shown.
  if (pr.state === "unknown") return pr.source === "github" ? "state unknown" : "state not checked live";
  if (pr.source !== "github") return `last recorded ${pr.state} · not checked live`;
  return `${pr.state}${pr.state === "open" || pr.state === "draft" ? ` · CI ${pr.ci === "none" ? "not reported" : pr.ci}` : ""}`;
}

/** Markdown and run-on whitespace removed, for text shown as a plain line (FAC-927). */
export function stapleConsolePlainText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,:;!?]|$)/g, "$1$2")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The first sentence of a question or reason as one plain line, clipped at a word. */
export function stapleConsoleSummaryLine(text: string, max = 120): string {
  const plain = stapleConsolePlainText(text);
  const sentence = /^.+?[.?!](?=\s+[A-Z*"'(]|$)/.exec(plain)?.[0] ?? plain;
  return clipStapleConsoleText(sentence, max);
}

/** Shorten long text at a word boundary with a visible ellipsis, never mid-word (STA-205). */
export function clipStapleConsoleText(text: string, max = 400): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * A plain feature name from a task title (FAC-620 v2): drops leading task IDs ("FAC-829: ",
 * "FAC-626 source | "), asides that cite IDs, and a trailing aside, then clips at a word.
 */
export function stapleConsoleDisplayName(title: string, max = 64): string {
  let name = title
    .replace(/\s*\([^()]*\b[A-Z][A-Z0-9]*-\d+[^()]*\)/g, "")
    .replace(/^\s*(?:[A-Z][A-Z0-9]*-\d+(?:\/\d+)?(?:\s+[a-z0-9][\w-]*){0,3}\s*[|:]\s*)+/, "")
    .replace(/^\s*[A-Z][A-Z0-9]*-\d+\s+/, "")
    .trim();
  const aside = /\s*\([^()]*\)\s*$/.exec(name);
  if (aside && aside.index >= 16) name = name.slice(0, aside.index).trim();
  name = name.replace(/[\s|:,;-]+$/, "");
  if (!name) return title.trim();
  return clipStapleConsoleText(name.charAt(0).toUpperCase() + name.slice(1), max);
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

export function isStapleConsoleReviewIssue(
  issue: Pick<StapleConsoleIssueInput, "title" | "reviewerAgentIds">,
  agent: StapleConsoleAgentInput | undefined,
) {
  if (/\b(review|verify|verification)\b/i.test(issue.title)) return true;
  if (!agent) return false;
  // Assigned to its own native review stage's reviewer: still an implementation task (FAC-838).
  if (issue.reviewerAgentIds?.includes(agent.id)) return false;
  return agent.role === "qa" || /reviewer/i.test(agent.name);
}
const isReviewIssue = isStapleConsoleReviewIssue;

const VERDICT_PATTERNS: Array<{ outcome: StapleConsoleReviewOutcome; pattern: RegExp }> = [
  { outcome: "approved", pattern: /\bno\s+(?:further\s+|more\s+)?changes\s+(?:are\s+)?(?:requested|required|needed)\b/gi },
  { outcome: "changes_requested", pattern: /\brequest(?:s|ed|ing)?\s+changes\b/gi },
  { outcome: "changes_requested", pattern: /\bchanges\s+requested\b/gi },
  { outcome: "changes_requested", pattern: /\b(?:requires?|needs?)\s+(?:a\s+)?(?:focused\s+)?correction\b/gi },
  { outcome: "changes_requested", pattern: /^(?:verdict:?\s*)?(?:fail(?:ed|s)?|rejected?)\b/gi },
  { outcome: "approved", pattern: /^(?:verdict:?\s*)?(?:pass(?:ed|es)?|approved?|lgtm)\b/gi },
  { outcome: "approved", pattern: /\b(?:review|verification)\s+(?:is\s+complete:?\s+)?(?:passes|passed|approved|pass)\b/gi },
];
// A phrase right after a negation ("no changes requested") or naming an earlier verdict ("the
// previous REQUEST CHANGES"), or one followed by "is resolved", is not this comment's verdict.
const NEGATED_OR_PRIOR_BEFORE = /\b(?:no|not|without|never|zero|0|previous(?:ly)?|earlier|prior|former|old)\s+(?:[\w-]+\s+){0,2}$/i;
const RESOLVED_AFTER = /^\s+(?:[\w#-]+\s+){0,4}?(?:is|are|was|were|has been|have been)\s+(?:now\s+)?(?:resolved|addressed|fixed|cleared|superseded)\b/i;

/**
 * The verdict a reviewer's comment states in its opening line, or null when it states none
 * (FAC-838). The earliest verdict phrase wins, so "PASS ... supersedes REQUEST CHANGES" is a pass.
 * Negated or past-tense references ("no changes requested", "the earlier REQUEST CHANGES is
 * resolved") never request changes.
 */
export function stapleConsoleVerdictOfComment(body: string): StapleConsoleReviewOutcome | null {
  const firstLine = body.trim().split(/\r?\n/, 1)[0] ?? "";
  const text = firstLine.replace(/[*_`#>]/g, "").replace(/^[\s\-\u2014:]+/, "").slice(0, 300);
  let best: { outcome: StapleConsoleReviewOutcome; index: number } | null = null;
  for (const { outcome, pattern } of VERDICT_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const before = text.slice(0, match.index);
      const after = text.slice(match.index + match[0].length);
      if (NEGATED_OR_PRIOR_BEFORE.test(before) || RESOLVED_AFTER.test(after)) continue;
      if (!best || match.index < best.index) best = { outcome, index: match.index };
      break;
    }
  }
  return best?.outcome ?? null;
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

function hasPendingRecovery(ctx: IssueRunContext) {
  return ctx.runs.some((run) => PENDING_RUN_STATUSES.has(run.status))
    || ctx.wakes.some((wake) => PENDING_WAKE_STATUSES.has(wake.status));
}

// A queued retry or wake is not recovery yet: the flag stays until a run
// actually starts (FAC-840). Say so, so the board does not read as handled.
function pendingRecoveryNote(ctx: IssueRunContext) {
  return hasPendingRecovery(ctx) ? "; recovery queued, not started" : "";
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
  // A live issue monitor is a stated external wait; a running run means the recovery wake resumed it.
  if (ctx.issue.monitorServiceName || ctx.issue.waitKind || activeRunOf(ctx.runs)) return null;
  return {
    rule: "blocked_without_blocker",
    issueIdentifier: ctx.issue.identifier,
    reason: `Blocked, but no open blocker, pending question or external wait${pendingRecoveryNote(ctx)}`,
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
  // A retry that is actually running is recovery in progress; a queued one is not.
  if (activeRunOf(ctx.runs)) return null;
  const finished = ctx.runs.filter((run) => !ACTIVE_RUN_STATUSES.has(run.status) && !PENDING_RUN_STATUSES.has(run.status));
  const count = STAPLE_CONSOLE_THRESHOLDS.repeatedFailureCount;
  const recent = finished.slice(0, count);
  if (recent.length < count || !recent.every((run) => FAILED_RUN_STATUSES.has(run.status))) return null;
  const signature = failureSignature(recent[0]!);
  if (!recent.every((run) => failureSignature(run) === signature)) return null;
  return {
    rule: "repeated_failure",
    issueIdentifier: ctx.issue.identifier,
    reason: `Same failure ${count} times in a row: ${signature}${pendingRecoveryNote(ctx)}`,
  };
}

/** An open PR whose head has had no check run for 10 min: CI never started. Clears once a check run exists. */
export function stuckCiNotStarted(
  pr: StapleConsolePullRequestInput,
  issueIdentifier: string,
  nowMs: number,
): StapleConsoleStuckFlag | null {
  if (pr.source !== "github" || pr.ci !== "none") return null;
  if (pr.state !== "open" && pr.state !== "draft") return null;
  const sinceMs = ms(pr.headCommittedAt ?? null);
  if (sinceMs === null || nowMs - sinceMs <= STAPLE_CONSOLE_THRESHOLDS.ciNotStartedMs) return null;
  const head = pr.headSha ? ` head ${pr.headSha.slice(0, 9)}` : " head";
  return {
    rule: "ci_not_started",
    issueIdentifier,
    reason: `PR #${pr.number}${head} has no CI check run ${formatStapleConsoleDuration(nowMs - sinceMs)} after its commit`,
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
  const decisionsByIssueId = new Map<string, StapleConsoleReviewDecisionInput[]>();
  for (const decision of input.reviewDecisions ?? []) {
    decisionsByIssueId.set(decision.issueId, [...(decisionsByIssueId.get(decision.issueId) ?? []), decision]);
  }
  const parsedMap = input.capabilityMap ? parseStapleConsoleCapabilityMap(input.capabilityMap.body) : null;
  const featureNames = parsedMap?.ok ? parsedMap.map.names ?? {} : {};
  const nameOf = (issue: StapleConsoleIssueInput) => featureNames[issue.identifier] ?? stapleConsoleDisplayName(issue.title);
  const agentName = (agentId: string | null | undefined) => agentsById.get(agentId ?? "")?.name ?? null;
  const assigneeName = (issue: StapleConsoleIssueInput) => agentName(issue.assigneeAgentId) ?? (issue.assigneeUserId ? "Ethan" : null);
  const latestCommentByIssue = new Map<string, StapleConsoleCommentInput>();
  for (const comment of input.comments ?? []) {
    const existing = latestCommentByIssue.get(comment.issueId);
    if (!existing || (ms(comment.createdAt) ?? 0) > (ms(existing.createdAt) ?? 0)) latestCommentByIssue.set(comment.issueId, comment);
  }
  // Red reasons per task, for the capability claims that link them.
  const stuckReasonByIssue = new Map<string, string>();
  const needsEthanByIssue = new Map<string, string>();

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
    // Rounds come from recorded review verdicts (FAC-838): each changes-requested verdict that
    // follows a correction attempt (or opens the history) starts a new Build round. An approval
    // never adds one, and a review task may stay open across its focused corrections.
    const doneReviews = reviewMembers.filter((issue) => issue.status === "done");
    const openReview = reviewMembers.find((issue) => !isStapleConsoleTerminal(issue.status)) ?? null;
    const lastReviewDoneAt = latest(doneReviews.map((issue) => issue.completedAt ?? issue.updatedAt));
    const lastReviewDoneMs = ms(lastReviewDoneAt);
    const buildSide = [root, ...buildMembers];
    // A native review stage runs on the task itself: its reviewer's runs there are review
    // participation, never a correction attempt.
    const buildRuns: StapleConsoleRunInput[] = [];
    const nativeReviewRuns: StapleConsoleRunInput[] = [];
    for (const issue of buildSide) {
      const reviewers = new Set([
        ...(issue.reviewerAgentIds ?? []),
        ...(decisionsByIssueId.get(issue.id) ?? []).flatMap((decision) => decision.reviewerAgentId ? [decision.reviewerAgentId] : []),
      ]);
      for (const run of runsByIssue.get(issue.id) ?? []) (reviewers.has(run.agentId) ? nativeReviewRuns : buildRuns).push(run);
    }
    const nativeReviewActive = buildSide.some((issue) => issue.reviewStageActive && !isStapleConsoleTerminal(issue.status));
    const buildRunStartMs = buildRuns.map((run) => ms(run.startedAt ?? run.createdAt) ?? 0);
    const buildRunStartedBetween = (fromMs: number, toMs: number) =>
      buildRunStartMs.some((start) => start > fromMs && start <= toMs);
    const decisions = members.flatMap((issue) => decisionsByIssueId.get(issue.id) ?? [])
      .filter((decision) => ms(decision.at) !== null)
      .sort((a, b) => ms(a.at)! - ms(b.at)!);
    let corrections = 0;
    let previous: StapleConsoleReviewDecisionInput | null = null;
    for (const decision of decisions) {
      if (decision.outcome === "changes_requested" && (
        !previous
        || previous.outcome === "approved"
        || buildRunStartedBetween(ms(previous.at)!, ms(decision.at)!)
      )) corrections += 1;
      previous = decision;
    }
    const lastDecision = decisions.at(-1) ?? null;
    const lastDecisionMs = lastDecision ? ms(lastDecision.at)! : null;
    const round = 1 + corrections;
    const reviewedRounds = corrections + (lastDecision?.outcome === "approved" ? 1 : 0)
      || (doneReviews.length > 0 ? 1 : 0);
    const buildActivityAfterReview = lastReviewDoneMs !== null && (
      buildRunStartMs.some((start) => start > lastReviewDoneMs)
      || buildMembers.some((issue) => (ms(issue.createdAt) ?? 0) > lastReviewDoneMs)
    );
    const openBuild = buildMembers.filter((issue) => !isStapleConsoleTerminal(issue.status));
    const mergedPrs = prs.filter((pr) => pr.state === "merged");
    const openPr = prs.find((pr) => pr.state === "open" || pr.state === "draft") ?? null;
    const ciMonitor = members.find((issue) =>
      !isStapleConsoleTerminal(issue.status)
      && (issue.waitKind === "ci" || /github|actions|\bci\b/i.test(issue.monitorServiceName ?? "")));
    const buildRunActive = activeRunOf(buildRuns) !== null;
    const ciWaiting = Boolean(ciMonitor || (openPr && openPr.ci === "pending"));
    const lastBuildRunAt = latest(buildRuns.map((run) => run.finishedAt));
    // After changes were requested, the review is back in play once a reviewer run actually starts
    // (a queued one is not participation) or a new review task opens, later than the last
    // correction run started.
    const lastBuildStartMs = buildRunStartMs.length > 0 ? Math.max(...buildRunStartMs) : null;
    const afterCorrection = (at: string | null) => at !== null && lastDecisionMs !== null
      && (ms(at) ?? 0) > lastDecisionMs && (lastBuildStartMs === null || (ms(at) ?? 0) > lastBuildStartMs);
    const startedAt = (run: StapleConsoleRunInput) => PENDING_RUN_STATUSES.has(run.status) ? null : run.startedAt;
    const reviewTaskReengagedAt = latest(reviewMembers.flatMap((issue) => [
      ...(runsByIssue.get(issue.id) ?? []).map(startedAt),
      issue.createdAt,
    ]).filter(afterCorrection));
    const nativeReengagedAt = latest(nativeReviewRuns.map(startedAt).filter(afterCorrection));
    const reviewReengagedAt = latest([reviewTaskReengagedAt, nativeReengagedAt]);
    const reviewOpen = Boolean(openReview) || nativeReviewActive
      || (lastDecision?.outcome === "changes_requested" && nativeReengagedAt !== null);
    const correcting = lastDecision?.outcome === "changes_requested" && !(reviewOpen && reviewReengagedAt);

    // Merged needs PR merge evidence (FAC-837); task completion alone is not source integration.
    const mergedAt = latest(mergedPrs.map((pr) => pr.mergedAt));
    const mergeConfirmed = mergedPrs.length > 0 && !openPr;
    let completion: StapleConsoleCompletion | null = null;
    let completionNote: string | null = null;
    let step: StapleConsoleCardStep;
    let stepSince: string | null;
    if (mergeConfirmed && (root.status === "done" || (!openReview && openBuild.length === 0))) {
      step = "merged";
      completion = "merged";
      stepSince = mergedAt ?? root.completedAt;
    } else if (root.status === "done") {
      completion = "task_done";
      stepSince = root.completedAt ?? root.updatedAt;
      const label = (pr: StapleConsolePullRequestInput) => `${pr.repo.split("/")[1] ?? pr.repo}#${pr.number}`;
      if (openPr) {
        step = openPr.ci === "pending" || openPr.ci === "failure" ? "ci" : "review";
        // Only a live GitHub read proves the PR is still open; a recorded status can be stale.
        completionNote = openPr.source === "github"
          ? `Task done; ${label(openPr)} is still open, not merged`
          : `Task done; ${label(openPr)} recorded open, merge not confirmed`;
      } else {
        step = "done";
        const unknownPr = prs.find((pr) => pr.state === "unknown");
        completionNote = unknownPr
          ? `Task done; ${label(unknownPr)} state unknown, merge not confirmed`
          : prs.length > 0
            ? `Task done; ${label(prs[0]!)} closed without merging`
            : "Task done; no PR, so nothing was merged";
      }
    } else if (correcting) {
      step = ciWaiting && !buildRunActive ? "ci" : "build";
      stepSince = step === "ci"
        ? ciMonitor?.monitorTriggeredAt ?? openPr?.ciStartedAt ?? lastBuildRunAt
        : lastDecision!.at;
    } else if (reviewOpen) {
      step = "review";
      stepSince = reviewReengagedAt
        ?? (openReview ? openReview.startedAt ?? openReview.createdAt : earliest(nativeReviewRuns.map(startedAt)) ?? root.updatedAt);
    } else if (lastDecision?.outcome === "approved" && openBuild.length === 0) {
      // Approved and nothing new to build: awaiting merge. Later merge/CI runs are not a correction.
      step = "review";
      stepSince = lastDecision.at;
    } else if (!lastDecision && doneReviews.length > 0 && !buildActivityAfterReview && openBuild.length === 0) {
      // Last review finished without a recorded verdict and nothing went back to Build.
      step = "review";
      stepSince = lastReviewDoneAt;
    } else if (ciWaiting && !buildRunActive) {
      step = "ci";
      stepSince = ciMonitor?.monitorTriggeredAt ?? openPr?.ciStartedAt ?? lastBuildRunAt;
    } else if (openBuild.length > 0 || openPr || buildRunActive || root.status === "in_progress") {
      step = "build";
      stepSince = lastDecision?.outcome === "changes_requested"
        ? lastDecision.at
        : doneReviews.length > 0 && !lastDecision
          ? lastReviewDoneAt
          : earliest([...openBuild.map((issue) => issue.startedAt ?? issue.createdAt), root.startedAt]);
    } else {
      step = "queued";
      stepSince = root.createdAt;
    }
    const reviewEvidence = doneReviews.length > 0 || decisions.length > 0;
    const currentIndex = step === "done" ? -1 : STAPLE_CONSOLE_STEPS.indexOf(step);
    const steps: StapleConsoleStepCell[] = STAPLE_CONSOLE_STEPS.map((cellStep, index) => ({
      step: cellStep,
      state: step === "done"
        // Task-only completion: Build happened; CI, Review and Merge show only with evidence.
        ? cellStep === "queued" || cellStep === "build" || (cellStep === "review" && reviewEvidence) ? "done" : "skipped"
        : index < currentIndex ? "done" : index === currentIndex ? "current" : "todo",
      rounds: cellStep === step && (step === "build" || step === "ci" || step === "review")
        ? round
        : cellStep === "review" && reviewedRounds > 0
          ? reviewedRounds
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

    for (const pr of prs) {
      const owner = byId.get(pr.issueId);
      const flag = owner && !isStapleConsoleTerminal(owner.status)
        ? stuckCiNotStarted(pr, owner.identifier, nowMs)
        : null;
      if (flag) stuck.push(flag);
    }
    for (const flag of stuck) if (!stuckReasonByIssue.has(flag.issueIdentifier)) stuckReasonByIssue.set(flag.issueIdentifier, flag.reason);
    for (const item of needsEthan) if (!needsEthanByIssue.has(item.issueIdentifier)) needsEthanByIssue.set(item.issueIdentifier, item.question);

    const mergedToday = completion === "merged" && mergedAt !== null && stapleConsoleDayKey(mergedAt) === todayKey;
    const completedToday = root.completedAt !== null && stapleConsoleDayKey(root.completedAt) === todayKey;
    // Show open workstreams, those merged or finished today, and Done tasks whose PR is still open
    // (FAC-837: unmerged work stays in flight past its completion day); older finished work is history.
    const unmergedDone = completion === "task_done" && openPr !== null;
    if (isStapleConsoleTerminal(root.status) && !mergedToday && !completedToday && !unmergedDone) continue;
    if (root.status === "backlog" && members.length === 1 && memberRuns.length === 0) continue;

    const lane = resolveLane(stream, byId, byIdentifier);
    const memberView = (issue: StapleConsoleIssueInput): StapleConsoleMember => ({
      identifier: issue.identifier,
      title: issue.title,
      status: issue.status,
      role: issue.id === root.id ? "coordinator" : reviewIds.has(issue.id) ? "review" : "build",
      assigneeName: assigneeName(issue),
    });
    const newestOpenMember = members
      .filter((issue) => issue.id !== root.id && !isStapleConsoleTerminal(issue.status))
      .sort((a, b) => (ms(b.createdAt) ?? 0) - (ms(a.createdAt) ?? 0))[0];
    const lastComment = members
      .map((issue) => ({ issue, comment: latestCommentByIssue.get(issue.id) }))
      .filter((entry): entry is { issue: StapleConsoleIssueInput; comment: StapleConsoleCommentInput } => Boolean(entry.comment))
      .sort((a, b) => (ms(b.comment.createdAt) ?? 0) - (ms(a.comment.createdAt) ?? 0))[0];
    cards.push({
      id: root.id,
      identifier: root.identifier,
      title: root.title,
      name: nameOf(root),
      ownerName: (activeRun ? agentName(activeRun.agentId) : null)
        ?? (newestOpenMember ? assigneeName(newestOpenMember) : null)
        ?? assigneeName(root),
      shipped: completion !== null && !unmergedDone,
      review: lastDecision
        ? { outcome: lastDecision.outcome, reviewerName: agentName(lastDecision.reviewerAgentId), at: lastDecision.at }
        : null,
      lastComment: lastComment
        ? {
          issueIdentifier: lastComment.issue.identifier,
          authorName: agentName(lastComment.comment.authorAgentId) ?? (lastComment.comment.authorUserId ? "Ethan" : null),
          at: lastComment.comment.createdAt,
          excerpt: clipStapleConsoleText(lastComment.comment.body.replace(/\s+/g, " ").trim(), 240),
        }
        : null,
      status: root.status,
      lane: lane.lane,
      laneSource: lane.laneSource,
      betaTag: lane.betaTag,
      facIds: lane.facIds,
      step,
      round,
      completion,
      completionNote,
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
        mergedAt: pr.mergedAt,
        mergeCommitSha: pr.mergeCommitSha ?? null,
        inInstalledBuild: pr.inInstalledBuild ?? null,
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
    || Number(a.completion !== null) - Number(b.completion !== null)
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

  // Level 1 (founder direction 2026-11-09 13:50): stuck work with its reason first, then founder
  // questions, then Done work whose PR nobody merges. Stuck lists stay short, so both reasons
  // stay on the first screen (FAC-927).
  const attention: StapleConsoleAttentionItem[] = [];
  for (const card of cards) {
    const first = card.stuck[0];
    if (!first) continue;
    attention.push({
      kind: "stuck",
      cardId: card.id,
      identifier: first.issueIdentifier,
      name: card.name,
      text: card.stuck.length > 1 ? `${first.reason} (+${card.stuck.length - 1} more)` : first.reason,
      href: `/issues/${first.issueIdentifier}`,
      linkLabel: "Open",
    });
  }
  for (const card of cards) {
    for (const item of card.needsEthan) {
      attention.push({
        kind: "needs_you",
        cardId: card.id,
        identifier: item.issueIdentifier,
        name: card.name,
        text: item.question,
        href: item.href,
        linkLabel: item.kind === "approval" ? "Open approval" : item.kind === "assigned_to_user" ? "Open task" : "Answer",
      });
    }
  }
  for (const card of cards) {
    if (card.completion !== "task_done" || card.shipped) continue;
    const openPr = card.pullRequests.find((pr) => pr.state === "open" || pr.state === "draft");
    attention.push({
      kind: "unowned_merge",
      cardId: card.id,
      identifier: card.identifier,
      name: card.name,
      text: card.completionNote ?? "Task done, merge not confirmed",
      href: openPr?.url ?? `/issues/${card.identifier}`,
      linkLabel: openPr ? "Open PR" : "Open",
    });
  }

  // Level 2: capability claims, colored from the tasks and PRs they link.
  const onBoard = new Set(cards.map((card) => card.id));
  const prRank = { github: 3, work_product: 2, reference: 1 } as const;
  const proofPr = (pr: StapleConsolePullRequestInput): StapleConsoleProofPullRequest => ({
    label: `${pr.repo.split("/")[1] ?? pr.repo}#${pr.number}`,
    url: pr.url,
    state: pr.state,
    mergedAt: pr.mergedAt,
    mergeCommitSha: pr.mergeCommitSha ?? null,
    ci: pr.ci,
    source: pr.source,
    inInstalledBuild: pr.inInstalledBuild ?? null,
  });
  const scopeOf = (issue: StapleConsoleIssueInput) => {
    const scope = [issue];
    for (let index = 0; index < scope.length && scope.length < 50; index += 1) {
      for (const child of childrenOf.get(scope[index]!.id) ?? []) if (!scope.includes(child)) scope.push(child);
    }
    return scope;
  };
  const capabilities = deriveStapleConsoleCapabilities(input.capabilityMap, parsedMap, {
    task: (identifier): StapleConsoleClaimTaskFacts | null => {
      const issue = byIdentifier.get(identifier);
      if (!issue) return null;
      const scope = scopeOf(issue);
      const prs = new Map<string, StapleConsolePullRequestInput>();
      for (const pr of scope.flatMap((member) => prsByIssue.get(member.id) ?? [])) {
        const key = `${pr.repo.toLowerCase()}#${pr.number}`;
        const existing = prs.get(key);
        if (!existing || prRank[pr.source] > prRank[existing.source]) prs.set(key, pr);
      }
      const openScope = scope.filter((member) => !isStapleConsoleTerminal(member.status));
      const reviews: StapleConsoleProofReview[] = scope.flatMap((member) => (decisionsByIssueId.get(member.id) ?? []).map((decision) => ({
        issueIdentifier: member.identifier,
        outcome: decision.outcome,
        reviewerName: agentName(decision.reviewerAgentId),
        at: decision.at,
      })));
      const cardId = cardIdOfIssue.get(issue.id);
      return {
        identifier: issue.identifier,
        name: nameOf(issue),
        status: issue.status,
        terminal: isStapleConsoleTerminal(issue.status),
        owned: Boolean(issue.assigneeAgentId || issue.assigneeUserId),
        stuckReason: openScope.map((member) => stuckReasonByIssue.get(member.identifier)).find(Boolean) ?? null,
        needsEthanReason: openScope.map((member) => needsEthanByIssue.get(member.identifier)).find(Boolean) ?? null,
        cardId: cardId && onBoard.has(cardId) ? cardId : null,
        pullRequests: [...prs.values()].map(proofPr),
        reviews,
      };
    },
    pullRequest: (ref) => {
      const matches = [...input.pullRequests, ...(input.claimPullRequests ?? [])].filter((pr) =>
        pr.repo.toLowerCase() === ref.repo.toLowerCase() && pr.number === ref.number);
      const best = matches.sort((a, b) => prRank[b.source] - prRank[a.source])[0];
      return best ? proofPr(best) : null;
    },
  }, input.installedBuild ?? null);

  const lanes = STAPLE_CONSOLE_LANES.map((lane) => ({
    key: lane.key,
    label: lane.label,
    cards: cards.filter((card) => card.lane === lane.key),
  })).filter((lane) => lane.cards.length > 0 || lane.key !== "other");

  return {
    generatedAt: input.now,
    issuePrefix: input.issuePrefix,
    header: stapleConsoleHeaderCounts(cards, attention),
    scheduled: input.scheduled,
    lanes,
    attention,
    capabilities,
    upNext,
    sources: input.sources,
  };
}

/**
 * Level 1 tiles, counted from the same lists the page shows (FAC-928): "Needs you" and "Stuck"
 * count the rows in Needs attention, "Merged today" the Finished today rows merged today.
 */
export function stapleConsoleHeaderCounts(
  cards: StapleConsoleCard[],
  attention: StapleConsoleAttentionItem[],
): StapleConsoleBoard["header"] {
  return {
    mergedToday: cards.filter((card) => card.mergedToday).length,
    inFlight: cards.filter((card) => card.step === "build" || card.step === "ci" || card.step === "review").length,
    needsEthan: attention.filter((item) => item.kind === "needs_you").length,
    stuck: attention.filter((item) => item.kind === "stuck").length,
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
