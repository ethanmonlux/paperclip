import { createHash } from "node:crypto";
import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  agentWakeupRequests,
  approvals,
  companies,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueRelations,
  issues,
  issueThreadInteractions,
  issueWorkProducts,
  projects,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import {
  buildStapleConsoleBoard,
  clipStapleConsoleText,
  extractStapleConsolePrRefs,
  isStapleConsoleTerminal,
  nextStapleConsoleLocalTime,
  stapleConsoleDayKey,
  stapleConsoleDefaultRepo,
  type StapleConsoleBoard,
  type StapleConsoleCiState,
  type StapleConsoleIssueInput,
  type StapleConsolePrState,
  type StapleConsolePullRequestInput,
  type StapleConsoleScheduledEvent,
  type StapleConsoleSourceStatus,
  type StapleConsoleMaintenanceHold,
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
const MAX_GITHUB_PRS_PER_REFRESH = 25;
const OPEN_PR_TTL_MS = 2 * 60_000;
const FINAL_PR_TTL_MS = 60 * 60_000;
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
    const headSha = typeof asRecord(pr?.head)?.sha === "string" ? String(asRecord(pr?.head)!.sha) : null;
    const state: StapleConsolePrState = mergedAt ? "merged"
      : pr?.state === "closed" ? "closed"
      : pr?.draft === true ? "draft"
      : pr?.state === "open" ? "open"
      : "unknown";
    let ci: StapleConsoleCiState = "unknown";
    let ciStartedAt: string | null = null;
    let headCommittedAt: string | null = null;
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
    const value = { state, mergedAt, headSha, ci, ciStartedAt, headCommittedAt };
    prCache.set(key, { value, expiresAt: nowMs + (state === "open" || state === "draft" ? OPEN_PR_TTL_MS : FINAL_PR_TTL_MS) });
    if (prCache.size > 500) prCache.delete(prCache.keys().next().value!);
    return value;
  }

  /** Every task-derived row is limited to tasks `actor` may read (private projects and private ancestry). */
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
      })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.visibility, "open"), executionIssueCondition(), readableIssue));

    const issueInputs: StapleConsoleIssueInput[] = issueRows.map((row) => {
      const monitor = asRecord(asRecord(row.executionState)?.monitor);
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
      };
    });
    // Only open work and work finished today can appear on the board.
    const liveIds = issueRows
      .filter((row) => !isStapleConsoleTerminal(row.status)
        || (row.completedAt && stapleConsoleDayKey(iso(row.completedAt)!) === todayKey))
      .map((row) => row.id);
    const allIds = issueRows.map((row) => row.id);

    const [agentRows, relationRows, runRows, wakeRows, interactionRows, approvalRows, workProductRows] = await Promise.all([
      db.select({ id: agents.id, name: agents.name, role: agents.role }).from(agents).where(eq(agents.companyId, companyId)),
      allIds.length === 0 ? [] : db
        .select({ blockerIssueId: issueRelations.issueId, blockedIssueId: issueRelations.relatedIssueId })
        .from(issueRelations)
        .where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.type, "blocks"))),
      liveIds.length === 0 ? [] : db
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
          inArray(heartbeatRuns.issueId, liveIds),
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
      liveIds.length === 0 ? [] : db
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
          inArray(issueWorkProducts.issueId, liveIds),
        )),
    ]);

    // ---- Pull requests: Paperclip records first, then a cached live GitHub read.
    const byId = new Map(issueRows.map((row) => [row.id, row]));
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
    for (const id of liveIds) {
      const row = byId.get(id)!;
      for (const ref of extractStapleConsolePrRefs(row.title, row.description, stapleConsoleDefaultRepo(titleChain(id)))) {
        if (pullRequests.some((pr) => pr.issueId === id && pr.repo.toLowerCase() === ref.repo.toLowerCase() && pr.number === ref.number)) continue;
        pullRequests.push({ issueId: id, ...ref, state: "unknown", mergedAt: null, ci: "unknown", ciStartedAt: null, source: "reference" });
      }
    }

    let github: StapleConsoleSourceStatus["github"];
    const missingOnGitHub = new Set<string>();
    const credential = await credentialProvider(companyId, actor).catch(() => null);
    if (!credential) {
      github = {
        available: false,
        detail: "No company GitHub secret, server token or connected GitHub account of yours is available, so PR state is Paperclip's recorded status (not live) and CI is unknown.",
      };
    } else {
      const unique = new Map<string, { repo: string; number: number }>();
      for (const pr of pullRequests) unique.set(`${pr.repo.toLowerCase()}#${pr.number}`, pr);
      const targets = [...unique.entries()].sort((a, b) => b[1].number - a[1].number).slice(0, MAX_GITHUB_PRS_PER_REFRESH);
      const viewer = `${actor.type}:${actor.userId ?? ""}:${actor.agentId ?? ""}`;
      const tokenHash = createHash("sha256").update(credential.token).digest("hex");
      const scope = `${companyId}|${viewer}|${tokenHash}`;
      const resolved = new Map<string, PullRequestSnapshot>();
      let failures = 0;
      await Promise.all(targets.map(async ([key, pr]) => {
        try {
          resolved.set(key, await resolvePullRequest(pr.repo, pr.number, credential.token, scope, nowMs));
        } catch (error) {
          if ((error as { status?: unknown }).status === 404) missingOnGitHub.add(key);
          else failures += 1;
        }
      }));
      const skipped = unique.size - targets.length;
      for (const pr of pullRequests) {
        const snapshot = resolved.get(`${pr.repo.toLowerCase()}#${pr.number}`);
        if (!snapshot) continue;
        Object.assign(pr, {
          state: snapshot.state, mergedAt: snapshot.mergedAt, ci: snapshot.ci, ciStartedAt: snapshot.ciStartedAt,
          headSha: snapshot.headSha, headCommittedAt: snapshot.headCommittedAt, source: "github",
        });
      }
      const gaps = [
        failures > 0 ? `GitHub read failed for ${failures} of ${targets.length} PRs` : null,
        skipped > 0 ? `${skipped} older PRs are beyond the ${MAX_GITHUB_PRS_PER_REFRESH}-PR refresh limit` : null,
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
    const serverInfo = getServerInfoSnapshot();
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

    const liveIdSet = new Set(liveIds);
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
      scheduled,
      sources: { github },
    });
    return { ...built, maintenanceHold };
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

  return { board };
}
