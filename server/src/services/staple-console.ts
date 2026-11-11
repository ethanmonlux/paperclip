import { createHash } from "node:crypto";
import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  agentWakeupRequests,
  approvals,
  companies,
  documents,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueDocuments,
  issueExecutionDecisions,
  issueRelations,
  issues,
  issueThreadInteractions,
  issueWorkProducts,
  projects,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import {
  STAPLE_CONSOLE_CAPABILITY_MAP_KEY,
  STAPLE_CONSOLE_LANES,
  buildStapleConsoleBoard,
  clipStapleConsoleText,
  parseStapleConsoleCapabilityMap,
  parseStapleConsolePrRef,
  extractStapleConsolePrRefs,
  isStapleConsoleReviewIssue,
  isStapleConsoleTerminal,
  nextStapleConsoleLocalTime,
  stapleConsoleDayKey,
  stapleConsoleDefaultRepo,
  stapleConsoleVerdictOfComment,
  type StapleConsoleBoard,
  type StapleConsoleCapabilityMapDocumentInput,
  type StapleConsoleCiState,
  type StapleConsoleIssueInput,
  type StapleConsolePrState,
  type StapleConsolePullRequestInput,
  type StapleConsoleReviewDecisionInput,
  type StapleConsoleScheduledEvent,
  type StapleConsoleSourceStatus,
  type StapleConsoleMaintenanceHold,
  type StapleAtlasSource,
} from "@paperclipai/shared/staple-console";
import { maintenanceHoldService } from "./maintenance-hold.js";
import { notFound } from "../errors.js";
import {
  resolveGitHubApiCredential,
  resolveManagedGitHubCredential,
  type GitHubApiCredential,
} from "./git-credentials.js";
import { ghFetch } from "./github-fetch.js";
import { secretService } from "./secrets.js";
import { issueService } from "./issues.js";
import { executionIssueCondition } from "./issue-visibility.js";
import {
  approvalReadSqlCondition,
  issueReadSqlCondition,
  projectReadSqlCondition,
  type AuthorizationActor,
} from "./authorization.js";
import { getServerInfoSnapshot } from "../server-info.js";

/** Runs older than this are not needed for any FAC-620 rule or card timing. */
const RUN_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
const MAX_RUNS = 4_000;
/** Review verdicts decide correction rounds (FAC-838); a review can span many days of corrections. */
const REVIEW_DECISION_LOOKBACK_MS = 30 * 24 * 60 * 60_000;
const MAX_REVIEW_COMMENTS = 2_000;
const MAX_GITHUB_PRS_PER_REFRESH = 25;
/** Capability-claim proof PRs (Level 4), read after the cards' own PRs and cached for an hour once final. */
const MAX_GITHUB_PROOF_PRS_PER_REFRESH = 30;
/** Installed-build containment checks per refresh; a merge commit's answer for one build never changes. */
const MAX_GITHUB_INSTALLED_CHECKS_PER_REFRESH = 20;
const INSTALLED_CHECK_TTL_MS = 6 * 60 * 60_000;
const STAPLE_REPO = STAPLE_CONSOLE_LANES.find((lane) => lane.key === "staple")?.defaultRepo ?? "ethanmonlux/paperclip";
const OPEN_PR_TTL_MS = 2 * 60_000;
const FINAL_PR_TTL_MS = 60 * 60_000;
const ATLAS_SOURCE_TTL_MS = 2 * 60_000;
/** Commit that introduced the current authored Atlas nodes. Advance only when their prose is reviewed. */
const ATLAS_AUTHORED_REVISION = "0135ef823d6216c3c9681050bcf31d2959ac3744";
const ATLAS_OWNER_ISSUE_ID = "c94e307b-8114-420b-bec5-5b6cdd555179";
const ATLAS_RELEVANT_PATHS = [
  "server/src/", "ui/src/", "packages/shared/src/", "packages/db/src/",
  "packages/paperclip-runner/", "packages/adapters/", "scripts/", "rules/",
  "maps/", "doc/", ".github/workflows/", "AGENTS.md",
] as const;
const GITHUB_TIMEOUT_MS = 8_000;

/**
 * Founder-stated nightly events (FAC-620). Paperclip has no record of these jobs,
 * so the board prints them as a schedule, not as observed runs.
 */
const NIGHTLY_EVENTS = [
  { label: "2:30 maintenance hold", time: "02:30" },
  { label: "3:20 wake", time: "03:20" },
  { label: "3:30 managed upgrade", time: "03:30" },
] as const;

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface PullRequestSnapshot {
  state: StapleConsolePrState;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headSha: string | null;
  ci: StapleConsoleCiState;
  ciStartedAt: string | null;
  headCommittedAt: string | null;
}

/** A shared company/server credential, or the viewing person's own managed GitHub connection grant. */
export type StapleConsoleGitHubCredential =
  | GitHubApiCredential
  | { token: string; source: "managed_connection"; secretName: null; login: string | null };

export interface StapleConsoleServiceOptions {
  fetch?: FetchLike;
  credentialProvider?: (companyId: string, actor: AuthorizationActor) => Promise<StapleConsoleGitHubCredential | null>;
  now?: () => Date;
  installedRevision?: () => string | null;
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function interactionQuestion(row: { kind: string; title: string | null; summary: string | null; payload: unknown }) {
  const payload = asRecord(row.payload);
  const questions = Array.isArray(payload?.questions) ? payload.questions : [];
  const firstPrompt = asRecord(questions[0])?.prompt;
  const candidates = [payload?.title, firstPrompt, payload?.prompt, row.title, row.summary];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return clipStapleConsoleText(candidate.trim());
  }
  return row.kind.replace(/_/g, " ");
}

function workProductState(status: string, metadata: Record<string, unknown> | null): StapleConsolePrState {
  const state = typeof metadata?.state === "string" ? metadata.state : status;
  if (state === "merged") return "merged";
  if (state === "closed" || state === "archived") return "closed";
  if (state === "draft") return "draft";
  if (["open", "active", "ready_for_review", "approved", "changes_requested"].includes(state)) return "open";
  return "unknown";
}

/** The native review stage on a task itself (FAC-838): who reviews it, and whether that review is waiting. */
function nativeReviewStage(
  state: Record<string, unknown> | null,
  policy: Record<string, unknown> | null,
): Pick<StapleConsoleIssueInput, "reviewerAgentIds" | "reviewStageActive"> {
  const reviewerAgentIds = new Set<string>();
  const stages: unknown = policy?.stages;
  for (const stage of Array.isArray(stages) ? stages : []) {
    const record = asRecord(stage);
    const participants: unknown = record?.type === "review" ? record.participants : null;
    for (const participant of Array.isArray(participants) ? participants : []) {
      const agentId = asRecord(participant)?.agentId;
      if (typeof agentId === "string") reviewerAgentIds.add(agentId);
    }
  }
  const inReview = state?.currentStageType === "review";
  const current = asRecord(state?.currentParticipant)?.agentId;
  if (inReview && typeof current === "string") reviewerAgentIds.add(current);
  return { reviewerAgentIds: [...reviewerAgentIds], reviewStageActive: inReview && state?.status === "pending" };
}

function parsePrUrl(url: string | null) {
  const match = url ? /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(url) : null;
  return match ? { repo: match[1]!, number: Number(match[2]) } : null;
}

/** The live wait record the server evaluates (FAC-840), shown instead of a heuristic. */
function consoleWaitRecord(monitor: Record<string, unknown> | null): { waitKind: string | null; waitDetail: string | null } {
  const kind = typeof monitor?.kind === "string" ? monitor.kind : null;
  if (!monitor || !kind) return { waitKind: null, waitDetail: null };
  const observation = asRecord(monitor.observation);
  const target = asRecord(monitor.target);
  const repo = typeof target?.repo === "string" ? target.repo : null;
  const sha = typeof target?.sha === "string" ? target.sha.slice(0, 9) : null;
  const pr = typeof target?.pullNumber === "number" ? `#${target.pullNumber}` : null;
  const label = repo ? `${repo}${pr ?? ""}${sha ? `@${sha}` : ""}` : null;
  const detail = typeof observation?.detail === "string" ? observation.detail
    : kind === "ci" && label ? `Waiting on CI for ${label}`
    : kind === "pr_mergeable" && label ? `Waiting for ${label} to be mergeable`
    : null;
  return { waitKind: kind, waitDetail: detail };
}

function summarizeCheckRuns(body: unknown): { ci: StapleConsoleCiState; ciStartedAt: string | null } {
  const runs = Array.isArray(asRecord(body)?.check_runs) ? (asRecord(body)!.check_runs as unknown[]) : [];
  if (runs.length === 0) return { ci: "none", ciStartedAt: null };
  let pending = false;
  let failed = false;
  let startedAt: string | null = null;
  for (const raw of runs) {
    const run = asRecord(raw);
    if (!run) continue;
    const started = typeof run.started_at === "string" ? run.started_at : null;
    if (started && (!startedAt || started < startedAt)) startedAt = started;
    if (run.status !== "completed") pending = true;
    else if (["failure", "timed_out", "cancelled", "action_required", "startup_failure"].includes(String(run.conclusion))) failed = true;
  }
  return { ci: failed ? "failure" : pending ? "pending" : "success", ciStartedAt: startedAt };
}

export function stapleConsoleService(db: Db, opts: StapleConsoleServiceOptions = {}) {
  const fetchImpl = opts.fetch ?? ghFetch;
  /**
   * A company secret or server token first. Otherwise the managed GitHub connection agents already
   * use, but only the viewer's own personal grant: never another person's or an agent's (STA-205).
   * Resolved on every refresh so a revoked grant or disabled connection stops live reads at once.
   */
  async function defaultCredential(companyId: string, actor: AuthorizationActor): Promise<StapleConsoleGitHubCredential | null> {
    const shared = await resolveGitHubApiCredential(db, companyId);
    if (shared) return shared;
    const userId = actor.type === "board" ? actor.userId : null;
    if (!userId) return null;
    const managed = await resolveManagedGitHubCredential(db, secretService(db), companyId, {
      responsibleUserId: userId, agentId: null, allowStandingDelegation: false,
    });
    if (!managed.credential?.token) return null;
    return {
      token: managed.credential.token, source: "managed_connection", secretName: null,
      login: managed.credential.githubIdentity?.login ?? null,
    };
  }

  const credentialProvider = opts.credentialProvider ?? defaultCredential;
  const prCache = new Map<string, { value: PullRequestSnapshot; expiresAt: number }>();
  const atlasSourceCache = new Map<string, { sourceRevision: string; changedPaths: string[]; observedAt: string; expiresAt: number }>();
  const holdService = maintenanceHoldService(db);

  async function githubJson(path: string, token: string) {
    const response = await fetchImpl(`https://api.github.com${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (!response.ok) throw Object.assign(new Error(`GitHub ${response.status}`), { status: response.status });
    return response.json() as Promise<unknown>;
  }

  async function resolvePullRequest(repo: string, number: number, token: string, scope: string, nowMs: number) {
    // Scoped to company, viewer and the exact token, so a read is only reused for the credential GitHub checked.
    const key = `${scope}|${repo.toLowerCase()}#${number}`;
    const cached = prCache.get(key);
    if (cached && cached.expiresAt > nowMs) return cached.value;
    const pr = asRecord(await githubJson(`/repos/${repo}/pulls/${number}`, token));
    const mergedAt = typeof pr?.merged_at === "string" ? pr.merged_at : null;
    const mergeCommitSha = mergedAt && typeof pr?.merge_commit_sha === "string" ? pr.merge_commit_sha : null;
    const headSha = typeof asRecord(pr?.head)?.sha === "string" ? String(asRecord(pr?.head)!.sha) : null;
    const state: StapleConsolePrState = mergedAt ? "merged"
      : pr?.state === "closed" ? "closed"
      : pr?.draft === true ? "draft"
      : pr?.state === "open" ? "open"
      : "unknown";
    let ci: StapleConsoleCiState = "unknown";
    let ciStartedAt: string | null = null;
    let headCommittedAt: string | null = null;
    // A merged PR's head checks are its CI proof (Level 4); unreadable leaves CI unknown.
    if (headSha && state === "merged") {
      ({ ci, ciStartedAt } = summarizeCheckRuns(
        await githubJson(`/repos/${repo}/commits/${headSha}/check-runs?per_page=100`, token).catch(() => null)));
      if (ci === "none") ci = "unknown";
    }
    if (headSha && (state === "open" || state === "draft")) {
      ({ ci, ciStartedAt } = summarizeCheckRuns(
        await githubJson(`/repos/${repo}/commits/${headSha}/check-runs?per_page=100`, token)));
      if (ci === "none") {
        // Zero check runs: time the head so the board can say CI never started (FAC-840).
        // Commit time is the closest GitHub record to the push; unreadable leaves it unknown.
        const commit = asRecord(await githubJson(`/repos/${repo}/commits/${headSha}`, token).catch(() => null));
        const date = asRecord(asRecord(commit?.commit)?.committer)?.date;
        headCommittedAt = typeof date === "string" ? date : null;
      }
    }
    const value = { state, mergedAt, mergeCommitSha, headSha, ci, ciStartedAt, headCommittedAt };
    prCache.set(key, { value, expiresAt: nowMs + (state === "open" || state === "draft" ? OPEN_PR_TTL_MS : FINAL_PR_TTL_MS) });
    if (prCache.size > 500) prCache.delete(prCache.keys().next().value!);
    return value;
  }

  /** Every task-derived row is limited to tasks `actor` may read (private projects and private ancestry). */
  const installedCache = new Map<string, { value: boolean | null; expiresAt: number }>();
  /** Whether `installedSha` contains `mergeSha` (GitHub compare); null when GitHub cannot say. */
  async function installedContains(repo: string, mergeSha: string, installedSha: string, token: string, scope: string, nowMs: number) {
    const key = `${scope}|${repo.toLowerCase()}|${mergeSha}|${installedSha}`;
    const cached = installedCache.get(key);
    if (cached && cached.expiresAt > nowMs) return cached.value;
    const body = asRecord(await githubJson(`/repos/${repo}/compare/${mergeSha}...${installedSha}`, token));
    const status = body?.status;
    const value = status === "ahead" || status === "identical" ? true : status === "behind" || status === "diverged" ? false : null;
    installedCache.set(key, { value, expiresAt: nowMs + INSTALLED_CHECK_TTL_MS });
    if (installedCache.size > 500) installedCache.delete(installedCache.keys().next().value!);
    return value;
  }

  async function board(companyId: string, actor: AuthorizationActor): Promise<StapleConsoleBoard> {
    const now = opts.now?.() ?? new Date();
    const nowIso = now.toISOString();
    const nowMs = now.getTime();
    const todayKey = stapleConsoleDayKey(nowIso);

    const [company] = await db
      .select({ id: companies.id, issuePrefix: companies.issuePrefix })
      .from(companies)
      .where(eq(companies.id, companyId));
    if (!company) throw notFound("Company not found");
    const [readableIssue, readableApproval, readableProject] = await Promise.all([
      issueReadSqlCondition(db, actor),
      approvalReadSqlCondition(db, actor),
      projectReadSqlCondition(db, actor),
    ]);

    const issueRows = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        description: issues.description,
        status: issues.status,
        parentId: issues.parentId,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        createdAt: issues.createdAt,
        startedAt: issues.startedAt,
        completedAt: issues.completedAt,
        updatedAt: issues.updatedAt,
        monitorNextCheckAt: issues.monitorNextCheckAt,
        executionState: issues.executionState,
        executionPolicy: issues.executionPolicy,
      })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.visibility, "open"), executionIssueCondition(), readableIssue));

    const issueInputs: StapleConsoleIssueInput[] = issueRows.map((row) => {
      const state = asRecord(row.executionState);
      const monitor = asRecord(state?.monitor);
      const monitorLive = monitor && !monitor.clearedAt;
      return {
        id: row.id,
        identifier: row.identifier ?? row.id.slice(0, 8),
        title: row.title,
        status: row.status,
        parentId: row.parentId,
        assigneeAgentId: row.assigneeAgentId,
        assigneeUserId: row.assigneeUserId,
        createdAt: iso(row.createdAt)!,
        startedAt: iso(row.startedAt),
        completedAt: iso(row.completedAt),
        updatedAt: iso(row.updatedAt)!,
        monitorNextCheckAt: iso(row.monitorNextCheckAt),
        monitorServiceName: monitorLive && typeof monitor.serviceName === "string" ? monitor.serviceName : null,
        monitorTriggeredAt: monitorLive && typeof monitor.lastTriggeredAt === "string" ? monitor.lastTriggeredAt : null,
        ...consoleWaitRecord(monitorLive ? monitor : null),
        ...nativeReviewStage(state, asRecord(row.executionPolicy)),
      };
    });
    const rowById = new Map(issueRows.map((row) => [row.id, row]));
    const allIds = issueRows.map((row) => row.id);
    // A Done task whose recorded PR is still open stays live past its completion day (FAC-837).
    const unmergedSince = nowMs - REVIEW_DECISION_LOOKBACK_MS;
    const recentDoneIds = issueRows
      .filter((row) => row.status === "done" && row.completedAt && row.completedAt.getTime() >= unmergedSince)
      .map((row) => row.id);
    const openPrRows = recentDoneIds.length === 0 ? [] : await db
      .select({ issueId: issueWorkProducts.issueId, status: issueWorkProducts.status, metadata: issueWorkProducts.metadata })
      .from(issueWorkProducts)
      .where(and(
        eq(issueWorkProducts.companyId, companyId),
        eq(issueWorkProducts.type, "pull_request"),
        inArray(issueWorkProducts.issueId, recentDoneIds),
      ));
    // Only open work, work finished today and Done work with an unmerged PR can appear on the board.
    const liveIdSet = new Set(issueRows
      .filter((row) => !isStapleConsoleTerminal(row.status)
        || (row.completedAt && stapleConsoleDayKey(iso(row.completedAt)!) === todayKey))
      .map((row) => row.id));
    for (const row of openPrRows) {
      const prState = workProductState(row.status, asRecord(row.metadata));
      if (prState !== "open" && prState !== "draft") continue;
      // Its whole workstream comes along, so the card keeps its root's runs and verdicts.
      const seen = new Set<string>();
      for (let current = rowById.get(row.issueId); current && !seen.has(current.id); current = rowById.get(current.parentId ?? "")) {
        seen.add(current.id);
        liveIdSet.add(current.id);
      }
    }
    const liveIds = [...liveIdSet];
    // Finished tasks under live work still hold that card's PRs, runs and review verdicts (FAC-837/838).
    const cardScopeIds = issueRows.filter((row) => {
      const seen = new Set<string>();
      for (let current: typeof row | undefined = row; current && !seen.has(current.id); current = rowById.get(current.parentId ?? "")) {
        if (liveIdSet.has(current.id)) return true;
        seen.add(current.id);
      }
      return false;
    }).map((row) => row.id);

    // ---- Capability map (Level 2): the newest readable `capability-map` issue document. Its claims'
    // tasks and their descendants are the proof scope: their PRs and review verdicts load too.
    const [mapRow] = await db
      .select({
        identifier: issues.identifier,
        issueId: issues.id,
        body: documents.latestBody,
        revisionNumber: documents.latestRevisionNumber,
        updatedAt: documents.updatedAt,
      })
      .from(issueDocuments)
      .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
      .innerJoin(issues, eq(issueDocuments.issueId, issues.id))
      .where(and(
        eq(issueDocuments.companyId, companyId),
        eq(issueDocuments.key, STAPLE_CONSOLE_CAPABILITY_MAP_KEY),
        readableIssue,
      ))
      .orderBy(desc(documents.updatedAt))
      .limit(1);
    const capabilityMap: StapleConsoleCapabilityMapDocumentInput | null = mapRow
      ? {
        issueIdentifier: mapRow.identifier ?? mapRow.issueId.slice(0, 8),
        revisionNumber: mapRow.revisionNumber,
        updatedAt: iso(mapRow.updatedAt)!,
        body: mapRow.body,
      }
      : null;
    const parsedMap = capabilityMap ? parseStapleConsoleCapabilityMap(capabilityMap.body) : null;
    const claims = parsedMap?.ok ? parsedMap.map.groups.flatMap((group) => group.capabilities.flatMap((capability) => capability.claims)) : [];
    const rowByIdentifier = new Map(issueRows.map((row) => [row.identifier, row]));
    const childIdsOf = new Map<string, string[]>();
    for (const row of issueRows) if (row.parentId) childIdsOf.set(row.parentId, [...(childIdsOf.get(row.parentId) ?? []), row.id]);
    const proofScope = new Set<string>();
    for (const identifier of claims.flatMap((claim) => [...(claim.issues ?? []), ...(claim.defects ?? [])])) {
      const start = rowByIdentifier.get(identifier);
      if (!start) continue;
      const queue = [start.id];
      while (queue.length > 0 && proofScope.size < 2_000) {
        const id = queue.shift()!;
        if (proofScope.has(id)) continue;
        proofScope.add(id);
        queue.push(...(childIdsOf.get(id) ?? []));
      }
    }
    const cardScopeSet = new Set(cardScopeIds);
    const proofOnlyIds = [...proofScope].filter((id) => !cardScopeSet.has(id));
    const evidenceScopeIds = [...cardScopeIds, ...proofOnlyIds];

    const [agentRows, relationRows, runRows, wakeRows, interactionRows, approvalRows, workProductRows, commentRows] = await Promise.all([
      db.select({ id: agents.id, name: agents.name, role: agents.role }).from(agents).where(eq(agents.companyId, companyId)),
      allIds.length === 0 ? [] : db
        .select({ blockerIssueId: issueRelations.issueId, blockedIssueId: issueRelations.relatedIssueId })
        .from(issueRelations)
        .where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.type, "blocks"))),
      cardScopeIds.length === 0 ? [] : db
        .select({
          id: heartbeatRuns.id,
          issueId: heartbeatRuns.issueId,
          agentId: heartbeatRuns.agentId,
          status: heartbeatRuns.status,
          createdAt: heartbeatRuns.createdAt,
          startedAt: heartbeatRuns.startedAt,
          finishedAt: heartbeatRuns.finishedAt,
          lastOutputAt: heartbeatRuns.lastOutputAt,
          errorCode: heartbeatRuns.errorCode,
          error: sql<string | null>`left(${heartbeatRuns.error}, 400)`,
        })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.issueId, cardScopeIds),
          or(gte(heartbeatRuns.createdAt, new Date(nowMs - RUN_LOOKBACK_MS)), eq(heartbeatRuns.status, "running")),
        ))
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(MAX_RUNS),
      db
        .select({
          issueId: sql<string | null>`${agentWakeupRequests.payload} ->> 'issueId'`,
          status: agentWakeupRequests.status,
          requestedAt: agentWakeupRequests.requestedAt,
        })
        .from(agentWakeupRequests)
        .where(and(
          eq(agentWakeupRequests.companyId, companyId),
          inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]),
        )),
      liveIds.length === 0 ? [] : db
        .select({
          id: issueThreadInteractions.id,
          issueId: issueThreadInteractions.issueId,
          kind: issueThreadInteractions.kind,
          status: issueThreadInteractions.status,
          title: issueThreadInteractions.title,
          summary: issueThreadInteractions.summary,
          payload: issueThreadInteractions.payload,
          addresseeAgentId: issueThreadInteractions.addresseeAgentId,
          createdAt: issueThreadInteractions.createdAt,
        })
        .from(issueThreadInteractions)
        .where(and(
          eq(issueThreadInteractions.companyId, companyId),
          eq(issueThreadInteractions.status, "pending"),
          isNull(issueThreadInteractions.dismissedAt),
          inArray(issueThreadInteractions.issueId, liveIds),
        )),
      liveIds.length === 0 ? [] : db
        .select({
          id: approvals.id,
          issueId: issueApprovals.issueId,
          type: approvals.type,
          status: approvals.status,
          payload: approvals.payload,
          createdAt: approvals.createdAt,
        })
        .from(issueApprovals)
        .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
        .where(and(
          eq(issueApprovals.companyId, companyId),
          eq(approvals.status, "pending"),
          inArray(issueApprovals.issueId, liveIds),
          readableApproval,
        )),
      evidenceScopeIds.length === 0 ? [] : db
        .select({
          issueId: issueWorkProducts.issueId,
          url: issueWorkProducts.url,
          status: issueWorkProducts.status,
          metadata: issueWorkProducts.metadata,
        })
        .from(issueWorkProducts)
        .where(and(
          eq(issueWorkProducts.companyId, companyId),
          eq(issueWorkProducts.type, "pull_request"),
          inArray(issueWorkProducts.issueId, evidenceScopeIds),
        )),
      // The newest comment on each card task, for the expanded card.
      cardScopeIds.length === 0 ? [] : db
        .selectDistinctOn([issueComments.issueId], {
          issueId: issueComments.issueId,
          authorAgentId: issueComments.authorAgentId,
          authorUserId: issueComments.authorUserId,
          body: sql<string>`left(${issueComments.body}, 600)`,
          createdAt: issueComments.createdAt,
        })
        .from(issueComments)
        .where(and(
          eq(issueComments.companyId, companyId),
          inArray(issueComments.issueId, cardScopeIds),
          isNull(issueComments.deletedAt),
          eq(issueComments.origin, "comment"),
        ))
        .orderBy(issueComments.issueId, desc(issueComments.createdAt)),
    ]);

    // ---- Review verdicts (FAC-838): native execution-stage decisions, and the verdict a review
    // task's own reviewer states in a comment. Comments by anyone else (the builder asking for
    // re-review, the coordinator) never count.
    const agentById = new Map(agentRows.map((agent) => [agent.id, { id: agent.id, name: agent.name, role: agent.role ?? null }]));
    const evidenceScopeIdSet = new Set(evidenceScopeIds);
    const reviewIssueRows = issueInputs.filter((row) =>
      evidenceScopeIdSet.has(row.id) && isStapleConsoleReviewIssue(row, agentById.get(row.assigneeAgentId ?? "")));
    const decisionSince = new Date(nowMs - REVIEW_DECISION_LOOKBACK_MS);
    const [executionDecisionRows, reviewCommentRows] = await Promise.all([
      evidenceScopeIds.length === 0 ? [] : db
        .select({
          issueId: issueExecutionDecisions.issueId,
          outcome: issueExecutionDecisions.outcome,
          actorAgentId: issueExecutionDecisions.actorAgentId,
          createdAt: issueExecutionDecisions.createdAt,
        })
        .from(issueExecutionDecisions)
        .where(and(
          eq(issueExecutionDecisions.companyId, companyId),
          eq(issueExecutionDecisions.stageType, "review"),
          inArray(issueExecutionDecisions.outcome, ["approved", "changes_requested"]),
          inArray(issueExecutionDecisions.issueId, evidenceScopeIds),
          gte(issueExecutionDecisions.createdAt, decisionSince),
        )),
      reviewIssueRows.length === 0 ? [] : db
        .select({
          issueId: issueComments.issueId,
          authorAgentId: issueComments.authorAgentId,
          body: sql<string>`left(${issueComments.body}, 400)`,
          createdAt: issueComments.createdAt,
        })
        .from(issueComments)
        .where(and(
          eq(issueComments.companyId, companyId),
          inArray(issueComments.issueId, reviewIssueRows.map((row) => row.id)),
          isNull(issueComments.deletedAt),
          eq(issueComments.origin, "comment"),
          sql`${issueComments.authorAgentId} is not null`,
          gte(issueComments.createdAt, decisionSince),
        ))
        .orderBy(desc(issueComments.createdAt))
        .limit(MAX_REVIEW_COMMENTS),
    ]);
    const reviewerOf = new Map(reviewIssueRows.map((row) => [row.id, row.assigneeAgentId]));
    const reviewDecisions: StapleConsoleReviewDecisionInput[] = executionDecisionRows.map((row) => ({
      issueId: row.issueId,
      outcome: row.outcome as StapleConsoleReviewDecisionInput["outcome"],
      at: iso(row.createdAt)!,
      source: "execution_decision" as const,
      reviewerAgentId: row.actorAgentId,
    }));
    for (const row of reviewCommentRows) {
      const author = agentById.get(row.authorAgentId ?? "");
      const byReviewer = row.authorAgentId === reviewerOf.get(row.issueId)
        || (author && isStapleConsoleReviewIssue({ title: "" }, author));
      const outcome = byReviewer ? stapleConsoleVerdictOfComment(row.body) : null;
      if (outcome) {
        reviewDecisions.push({ issueId: row.issueId, outcome, at: iso(row.createdAt)!, source: "verdict_comment", reviewerAgentId: row.authorAgentId });
      }
    }

    // ---- Pull requests: Paperclip records first, then a cached live GitHub read.
    const byId = rowById;
    const readableRelations = relationRows.filter((row) => byId.has(row.blockerIssueId) && byId.has(row.blockedIssueId));
    const titleChain = (id: string) => {
      const titles: string[] = [];
      const seen = new Set<string>();
      let current = byId.get(id);
      while (current && !seen.has(current.id)) {
        seen.add(current.id);
        titles.push(current.title);
        current = current.parentId ? byId.get(current.parentId) : undefined;
      }
      return titles;
    };
    const pullRequests: StapleConsolePullRequestInput[] = [];
    for (const row of workProductRows) {
      const parsed = parsePrUrl(row.url);
      if (!parsed) continue;
      pullRequests.push({
        issueId: row.issueId,
        ...parsed,
        url: row.url!,
        state: workProductState(row.status, asRecord(row.metadata)),
        mergedAt: null,
        ci: "unknown",
        ciStartedAt: null,
        source: "work_product",
      });
    }
    for (const id of evidenceScopeIds) {
      const row = byId.get(id)!;
      for (const ref of extractStapleConsolePrRefs(row.title, row.description, stapleConsoleDefaultRepo(titleChain(id)))) {
        if (pullRequests.some((pr) => pr.issueId === id && pr.repo.toLowerCase() === ref.repo.toLowerCase() && pr.number === ref.number)) continue;
        pullRequests.push({ issueId: id, ...ref, state: "unknown", mergedAt: null, ci: "unknown", ciStartedAt: null, source: "reference" });
      }
    }

    // PRs a claim names directly ("owner/repo#N"), not attached to any task.
    const claimPullRequests: StapleConsolePullRequestInput[] = [];
    for (const value of claims.flatMap((claim) => claim.prs ?? [])) {
      const ref = parseStapleConsolePrRef(value);
      if (!ref || claimPullRequests.some((pr) => pr.repo.toLowerCase() === ref.repo.toLowerCase() && pr.number === ref.number)) continue;
      claimPullRequests.push({ issueId: "", ...ref, state: "unknown", mergedAt: null, ci: "unknown", ciStartedAt: null, source: "reference" });
    }
    const serverInfo = getServerInfoSnapshot();

    let github: StapleConsoleSourceStatus["github"];
    const missingOnGitHub = new Set<string>();
    const credential = await credentialProvider(companyId, actor).catch(() => null);
    if (!credential) {
      github = {
        available: false,
        detail: "No company GitHub secret, server token or connected GitHub account of yours is available, so PR state is Paperclip's recorded status (not live) and CI is unknown.",
      };
    } else {
      // Card PRs first under their own limit; capability proof PRs after, under a separate one.
      const unique = new Map<string, { repo: string; number: number }>();
      for (const pr of pullRequests) if (cardScopeSet.has(pr.issueId)) unique.set(`${pr.repo.toLowerCase()}#${pr.number}`, pr);
      const targets = [...unique.entries()].sort((a, b) => b[1].number - a[1].number).slice(0, MAX_GITHUB_PRS_PER_REFRESH);
      const proofUnique = new Map<string, { repo: string; number: number }>();
      for (const pr of [...pullRequests, ...claimPullRequests]) {
        const key = `${pr.repo.toLowerCase()}#${pr.number}`;
        if (!unique.has(key)) proofUnique.set(key, pr);
      }
      const proofTargets = [...proofUnique.entries()].sort((a, b) => b[1].number - a[1].number).slice(0, MAX_GITHUB_PROOF_PRS_PER_REFRESH);
      const viewer = `${actor.type}:${actor.userId ?? ""}:${actor.agentId ?? ""}`;
      const tokenHash = createHash("sha256").update(credential.token).digest("hex");
      const scope = `${companyId}|${viewer}|${tokenHash}`;
      const resolved = new Map<string, PullRequestSnapshot>();
      let failures = 0;
      let proofFailures = 0;
      await Promise.all([
        ...targets.map(async ([key, pr]) => {
          try {
            resolved.set(key, await resolvePullRequest(pr.repo, pr.number, credential.token, scope, nowMs));
          } catch (error) {
            if ((error as { status?: unknown }).status === 404) missingOnGitHub.add(key);
            else failures += 1;
          }
        }),
        ...proofTargets.map(async ([key, pr]) => {
          try {
            resolved.set(key, await resolvePullRequest(pr.repo, pr.number, credential.token, scope, nowMs));
          } catch (error) {
            if ((error as { status?: unknown }).status === 404) missingOnGitHub.add(key);
            else proofFailures += 1;
          }
        }),
      ]);
      const skipped = unique.size - targets.length;
      const proofSkipped = proofUnique.size - proofTargets.length;
      for (const pr of [...pullRequests, ...claimPullRequests]) {
        const snapshot = resolved.get(`${pr.repo.toLowerCase()}#${pr.number}`);
        if (!snapshot) continue;
        Object.assign(pr, {
          state: snapshot.state, mergedAt: snapshot.mergedAt, mergeCommitSha: snapshot.mergeCommitSha, ci: snapshot.ci,
          ciStartedAt: snapshot.ciStartedAt, headSha: snapshot.headSha, headCommittedAt: snapshot.headCommittedAt, source: "github",
        });
      }
      // Level 4: does the installed Staple build contain each merged Staple PR?
      const installedSha = serverInfo.git.available ? serverInfo.git.fullSha : null;
      if (installedSha) {
        const merges = new Map<string, string>();
        for (const pr of [...pullRequests, ...claimPullRequests]) {
          if (pr.state === "merged" && pr.mergeCommitSha && pr.repo.toLowerCase() === STAPLE_REPO.toLowerCase()) {
            merges.set(pr.mergeCommitSha, pr.repo);
          }
        }
        const answers = new Map<string, boolean | null>();
        await Promise.all([...merges.entries()].slice(0, MAX_GITHUB_INSTALLED_CHECKS_PER_REFRESH).map(async ([sha, repo]) => {
          answers.set(sha, await installedContains(repo, sha, installedSha, credential.token, scope, nowMs).catch(() => null));
        }));
        for (const pr of [...pullRequests, ...claimPullRequests]) {
          if (pr.mergeCommitSha && answers.has(pr.mergeCommitSha)) pr.inInstalledBuild = answers.get(pr.mergeCommitSha)!;
        }
      }
      const gaps = [
        failures > 0 ? `GitHub read failed for ${failures} of ${targets.length} PRs` : null,
        skipped > 0 ? `${skipped} older PRs are beyond the ${MAX_GITHUB_PRS_PER_REFRESH}-PR refresh limit` : null,
        proofFailures > 0 ? `GitHub read failed for ${proofFailures} capability proof PRs` : null,
        proofSkipped > 0 ? `${proofSkipped} capability proof PRs are beyond the ${MAX_GITHUB_PROOF_PRS_PER_REFRESH}-PR refresh limit` : null,
      ].filter(Boolean);
      github = {
        available: failures < targets.length || targets.length === 0,
        detail: gaps.length === 0
          ? `Live GitHub read with ${credential.source === "managed_connection"
            ? `your connected GitHub account${credential.login ? ` (${credential.login})` : ""}`
            : `the server's existing ${credential.source === "server_env" ? "environment" : "company"} credential`} (cached up to 2 min).`
          : `${gaps.join("; ")}; those show Paperclip's recorded status (not live) with CI unknown.`,
      };
    }
    // Only a reference GitHub definitively answered 404 for (a wrong repo guess) is dropped. Timeouts,
    // rate limits and capped PRs keep their link with unknown state.
    const confirmedPullRequests = pullRequests.filter((pr) =>
      pr.source !== "reference" || !missingOnGitHub.has(`${pr.repo.toLowerCase()}#${pr.number}`));

    // ---- Scheduled events with their actual source
    const scheduled: StapleConsoleScheduledEvent[] = [];
    const [routineRows, watcherIssue] = await Promise.all([
      db
        .select({ title: routines.title, nextRunAt: routineTriggers.nextRunAt, label: routineTriggers.label })
        .from(routineTriggers)
        .innerJoin(routines, eq(routineTriggers.routineId, routines.id))
        .leftJoin(projects, and(eq(projects.id, routines.projectId), eq(projects.companyId, routines.companyId)))
        .where(and(
          or(isNull(routines.projectId), readableProject),
          eq(routineTriggers.companyId, companyId),
          eq(routineTriggers.enabled, true),
          eq(routineTriggers.archived, false),
          eq(routines.status, "active"),
          sql`${routineTriggers.nextRunAt} is not null`,
        ))
        .orderBy(routineTriggers.nextRunAt)
        .limit(3),
      Promise.resolve(issueRows.find((row) => /watcher log/i.test(row.title)) ?? null),
    ]);
    for (const nightly of NIGHTLY_EVENTS) {
      scheduled.push({
        label: nightly.label,
        at: nextStapleConsoleLocalTime(nowIso, nightly.time),
        detail: null,
        source: "Founder schedule in FAC-620; this job is not recorded in Paperclip",
        available: false,
      });
    }
    const lastSync = issueRows
      .filter((row) => /upstream sync/i.test(row.title))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    const upgrade = scheduled.find((event) => event.label.includes("upgrade"))!;
    upgrade.detail = [
      `Running ${serverInfo.git.available ? serverInfo.git.shortSha : "unknown build"}, server started ${serverInfo.processStartedAt}`,
      lastSync ? `last sync ${lastSync.identifier}: ${lastSync.status}` : null,
    ].filter(Boolean).join("; ");
    upgrade.source = `Server build info${lastSync ? ` and ${lastSync.identifier}` : ""}; the installer itself is not recorded in Paperclip`;
    if (watcherIssue) {
      const [lastComment] = await db
        .select({ createdAt: issueComments.createdAt })
        .from(issueComments)
        .where(and(eq(issueComments.companyId, companyId), eq(issueComments.issueId, watcherIssue.id)))
        .orderBy(desc(issueComments.createdAt))
        .limit(1);
      scheduled.push({
        label: "Hourly watcher",
        at: lastComment ? new Date(lastComment.createdAt.getTime() + 60 * 60_000).toISOString() : null,
        detail: lastComment ? `Last log entry ${lastComment.createdAt.toISOString()}` : "No watcher run logged yet",
        source: `${watcherIssue.identifier} log comments`,
        available: Boolean(lastComment),
      });
    } else {
      scheduled.push({ label: "Hourly watcher", at: null, detail: "No watcher log task found", source: "Paperclip issues", available: false });
    }
    for (const routine of routineRows) {
      scheduled.push({
        label: routine.label ? `${routine.title} (${routine.label})` : routine.title,
        at: iso(routine.nextRunAt),
        detail: null,
        source: "Paperclip routine trigger",
        available: true,
      });
    }
    const monitors = issueInputs
      .filter((issue) => issue.monitorNextCheckAt && !isStapleConsoleTerminal(issue.status))
      .sort((a, b) => Date.parse(a.monitorNextCheckAt!) - Date.parse(b.monitorNextCheckAt!))
      .slice(0, 3);
    for (const issue of monitors) {
      scheduled.push({
        label: `${issue.identifier} monitor check`,
        at: issue.monitorNextCheckAt,
        detail: issue.waitDetail ?? (issue.monitorServiceName ? `Waiting on ${issue.monitorServiceName}` : null),
        source: "Paperclip issue monitor",
        available: true,
      });
    }

    const maintenanceHold = await readMaintenanceHoldBanner();
    const built = buildStapleConsoleBoard({
      now: nowIso,
      issuePrefix: company.issuePrefix,
      issues: issueInputs,
      agents: agentRows.map((agent) => ({ id: agent.id, name: agent.name, role: agent.role ?? null })),
      relations: readableRelations,
      runs: runRows.filter((run) => run.issueId).map((run) => ({
        id: run.id,
        issueId: run.issueId!,
        agentId: run.agentId,
        status: run.status,
        createdAt: iso(run.createdAt)!,
        startedAt: iso(run.startedAt),
        finishedAt: iso(run.finishedAt),
        lastOutputAt: iso(run.lastOutputAt),
        errorCode: run.errorCode,
        error: run.error,
      })),
      wakes: wakeRows
        .filter((wake): wake is typeof wake & { issueId: string } => typeof wake.issueId === "string" && liveIdSet.has(wake.issueId))
        .map((wake) => ({ issueId: wake.issueId, status: wake.status, requestedAt: iso(wake.requestedAt)! })),
      interactions: interactionRows.map((row) => ({
        id: row.id,
        issueId: row.issueId,
        kind: row.kind,
        status: row.status,
        question: interactionQuestion(row),
        addresseeAgentId: row.addresseeAgentId,
        createdAt: iso(row.createdAt)!,
      })),
      approvals: approvalRows.map((row) => {
        const payload = asRecord(row.payload);
        const title = [payload?.title, payload?.summary, payload?.reason]
          .find((value): value is string => typeof value === "string" && value.trim().length > 0);
        return {
          id: row.id,
          issueId: row.issueId,
          type: row.type,
          status: row.status,
          title: clipStapleConsoleText(title ?? `Approval requested: ${row.type.replace(/_/g, " ")}`),
          createdAt: iso(row.createdAt)!,
        };
      }),
      pullRequests: confirmedPullRequests,
      claimPullRequests: claimPullRequests.filter((pr) => !missingOnGitHub.has(`${pr.repo.toLowerCase()}#${pr.number}`)),
      reviewDecisions,
      comments: commentRows.map((row) => ({
        issueId: row.issueId,
        authorAgentId: row.authorAgentId,
        authorUserId: row.authorUserId,
        body: row.body,
        createdAt: iso(row.createdAt)!,
      })),
      capabilityMap,
      installedBuild: serverInfo.git.available ? serverInfo.git.shortSha : null,
      scheduled,
      sources: { github },
    });
    return { ...built, maintenanceHold };
  }

  async function atlasSource(companyId: string, actor: AuthorizationActor): Promise<StapleAtlasSource> {
    const nowMs = (opts.now?.() ?? new Date()).getTime();
    const installed = getServerInfoSnapshot().git;
    const installedRevision = opts.installedRevision ? opts.installedRevision() : installed.available ? installed.fullSha : null;
    const result: StapleAtlasSource = {
      authoredRevision: ATLAS_AUTHORED_REVISION, sourceRevision: null, installedRevision,
      changedPaths: null, status: "unknown", observedAt: new Date(nowMs).toISOString(),
    };
    const credential = await credentialProvider(companyId, actor).catch(() => null);
    if (!credential) return result;
    const viewer = `${actor.type}:${actor.userId ?? ""}:${actor.agentId ?? ""}`;
    const scope = `${companyId}|${viewer}|${createHash("sha256").update(credential.token).digest("hex")}|${ATLAS_AUTHORED_REVISION}`;
    const cached = atlasSourceCache.get(scope);
    try {
      let source = cached;
      if (!source || source.expiresAt <= nowMs) {
        const head = asRecord(await githubJson(`/repos/${STAPLE_REPO}/commits/master`, credential.token));
        const sourceRevision = typeof head?.sha === "string" ? head.sha : null;
        if (!sourceRevision) throw new Error("GitHub source revision unavailable");
        let changedPaths: string[] = [];
        if (sourceRevision !== ATLAS_AUTHORED_REVISION) {
          const comparison = asRecord(await githubJson(`/repos/${STAPLE_REPO}/compare/${ATLAS_AUTHORED_REVISION}...${sourceRevision}`, credential.token));
          const files = Array.isArray(comparison?.files) ? comparison.files : null;
          if (!files || files.length >= 300 || !["ahead", "identical"].includes(String(comparison?.status))) throw new Error("GitHub source comparison incomplete");
          changedPaths = files.flatMap((file) => {
            const name = asRecord(file)?.filename;
            return typeof name === "string" ? [name] : [];
          });
        }
        source = { sourceRevision, changedPaths, observedAt: new Date(nowMs).toISOString(), expiresAt: nowMs + ATLAS_SOURCE_TTL_MS };
        atlasSourceCache.set(scope, source);
        if (atlasSourceCache.size > 100) atlasSourceCache.delete(atlasSourceCache.keys().next().value!);
      }
      let refreshIssueId: string | null = null;
      if (source.changedPaths.some((path) => ATLAS_RELEVANT_PATHS.some((prefix) => path.startsWith(prefix)))) {
        try {
          const [owner] = await db.select({ id: issues.id, companyId: issues.companyId, projectId: issues.projectId,
            assigneeAgentId: issues.assigneeAgentId }).from(issues).where(eq(issues.id, ATLAS_OWNER_ISSUE_ID));
          if (owner?.companyId === companyId && owner.assigneeAgentId) {
            // The authored revision is the dedupe boundary. Later commits share this task;
            // a reviewed explanation advances the revision and permits the next task.
            const refresh = await issueService(db).create(companyId, {
              parentId: owner.id,
              parentDepthPolicy: "allow_nested",
              projectId: owner.projectId,
              title: "Refresh System Atlas explanations for changed source",
              description: `Review the affected Atlas explanations against source ${source.sourceRevision}. Changed paths: ${source.changedPaths.join(", ")}. Keep source, installed and observed evidence distinct. Update the authored revision only after semantic review and verified source changes.`,
              status: "todo",
              priority: "medium",
              assigneeAgentId: owner.assigneeAgentId,
              originKind: "system_atlas_refresh",
              originId: ATLAS_AUTHORED_REVISION,
              idempotencyKey: `system-atlas-refresh:${ATLAS_AUTHORED_REVISION}`,
            });
            const readableIssue = await issueReadSqlCondition(db, actor);
            const [readableRefresh] = await db.select({ id: issues.id }).from(issues)
              .where(and(eq(issues.id, refresh.id), eq(issues.companyId, companyId), readableIssue));
            refreshIssueId = readableRefresh?.id ?? null;
          }
        } catch {
          // Comparison stays truthful. A later source read retries native routing.
        }
      }
      return { ...result, sourceRevision: source.sourceRevision, changedPaths: source.changedPaths,
        observedAt: source.observedAt, status: source.changedPaths.length ? "changed" : "current", refreshIssueId };
    } catch {
      // Keep last-good source evidence but mark the current comparison unknown.
      return cached ? { ...result, sourceRevision: cached.sourceRevision, changedPaths: cached.changedPaths, observedAt: cached.observedAt } : result;
    }
  }

  async function readMaintenanceHoldBanner(): Promise<StapleConsoleMaintenanceHold | null> {
    try {
      const status = await holdService.status();
      if (!status.hold) return null;
      return {
        since: status.hold.startedAt,
        drainDeadlineAt: status.hold.drainDeadlineAt,
        expiresAt: status.hold.expiresAt,
        queuedWakes: status.queuedRuns,
        runningRuns: status.runningRuns,
        parkedRuns: status.hold.parkedRunCount,
      };
    } catch {
      return null;
    }
  }

  return { board, atlasSource };
}
