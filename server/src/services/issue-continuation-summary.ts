import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { documentRevisions, documents, issueDocuments, issues } from "@paperclipai/db";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY, type SourceTrustMetadata } from "@paperclipai/shared";
import { documentService } from "./documents.js";
import { summarizeRunErrorForModel } from "./heartbeat-run-summary.js";
import { issueStatusChangedSince } from "./issue-stage-boundary.js";

export { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY };
export const ISSUE_CONTINUATION_SUMMARY_TITLE = "Continuation Summary";
export const ISSUE_CONTINUATION_SUMMARY_MAX_BODY_CHARS = 8_000;
const SUMMARY_SECTION_MAX_CHARS = 1_200;
const PATH_CANDIDATE_RE = /(?:^|[\s`"'(])((?:server|ui|packages|doc|scripts|\.github)\/[A-Za-z0-9._/-]+)/g;
const WAITING_FOR_REVIEW_OR_APPROVAL_RE =
  /\bwait(?:ing)? for\b.{0,160}\b(?:review(?:er)?(?: feedback)?|approval|board|human|user|operator)\b/i;

type IssueSummaryInput = {
  id: string;
  identifier: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
};

type RunSummaryInput = {
  id: string;
  status: string;
  error: string | null;
  errorCode?: string | null;
  resultJson?: Record<string, unknown> | null;
  stdoutExcerpt?: string | null;
  stderrExcerpt?: string | null;
  finishedAt?: Date | null;
};

type AgentSummaryInput = {
  id: string;
  name: string;
  adapterType: string | null;
};

export type IssueContinuationSummaryDocument = {
  key: typeof ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY;
  title: string | null;
  body: string;
  documentId: string;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
  sourceTrust: SourceTrustMetadata | null;
  updatedAt: Date;
};

function truncateText(value: string, maxChars: number) {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 20)).trimEnd()}\n[truncated]`;
}

function asNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readResultSummary(resultJson: Record<string, unknown> | null | undefined) {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) return null;
  return (
    asNonEmptyString(resultJson.summary) ??
    asNonEmptyString(resultJson.result) ??
    asNonEmptyString(resultJson.message) ??
    asNonEmptyString(resultJson.error) ??
    null
  );
}

function extractMarkdownSection(markdown: string | null | undefined, heading: string) {
  if (!markdown) return null;
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^##\\s+${escaped}\\s*$([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`, "im");
  const match = re.exec(markdown);
  const section = match?.[1]?.trim();
  return section ? truncateText(section, SUMMARY_SECTION_MAX_CHARS) : null;
}

function extractPathCandidates(...texts: Array<string | null | undefined>) {
  const seen = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(PATH_CANDIDATE_RE)) {
      const path = match[1]?.replace(/[),.;:]+$/, "");
      if (path) seen.add(path);
      if (seen.size >= 12) break;
    }
    if (seen.size >= 12) break;
  }
  return [...seen];
}

function inferMode(issue: IssueSummaryInput, run: RunSummaryInput) {
  if (issue.status === "done" || issue.status === "in_review") return "review";
  if (run.status === "failed" || run.status === "timed_out" || run.status === "cancelled" || run.status === "interrupted") return "implementation";
  if (issue.status === "backlog" || issue.status === "todo") return "plan";
  return "implementation";
}

// Generated for one status only. Carrying them into another status would let
// an earlier stage's wording park or misdirect the current stage.
const STATUS_NEXT_ACTIONS: Record<string, string> = {
  done: "Review the completed issue output and close any remaining follow-up comments.",
  in_review: "Wait for reviewer feedback or approval before continuing executor work.",
};
const GENERATED_STATUS_NEXT_ACTIONS = new Set(Object.values(STATUS_NEXT_ACTIONS));

function inferNextAction(issue: IssueSummaryInput, run: RunSummaryInput, previousNextAction: string | null) {
  const statusNextAction = STATUS_NEXT_ACTIONS[issue.status];
  if (statusNextAction) return statusNextAction;
  if (previousNextAction && GENERATED_STATUS_NEXT_ACTIONS.has(previousNextAction)) previousNextAction = null;
  if (run.status === "failed" || run.status === "timed_out") {
    return "Inspect the failed run, fix the cause, and resume from the most recent concrete action above.";
  }
  if (run.status === "cancelled") return "Confirm the cancellation reason before starting another run.";
  return previousNextAction ?? "Resume implementation from the acceptance criteria, latest comments, and this summary.";
}

function bulletList(items: string[], empty: string) {
  if (items.length === 0) return `- ${empty}`;
  return items.map((item) => `- ${item}`).join("\n");
}

function extractPreviousNextAction(previousBody: string | null | undefined) {
  const section = extractMarkdownSection(previousBody, "Next Action");
  if (!section) return null;
  return section
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .find(Boolean) ?? null;
}

export function extractContinuationSummaryNextAction(body: string | null | undefined) {
  return extractPreviousNextAction(body);
}

export function continuationSummaryParksExecutor(body: string | null | undefined) {
  const nextAction = extractContinuationSummaryNextAction(body);
  if (!nextAction) return false;
  return WAITING_FOR_REVIEW_OR_APPROVAL_RE.test(nextAction);
}

/**
 * A summary as some reader holds it: the body it saw and, when known, the
 * exact document revision that body was copied from.
 */
export type HeldContinuationSummary = {
  body: string;
  documentId: string | null;
  revisionId: string | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** The run context's summary snapshot, naming the exact revision it copied. */
export function continuationSummaryContextSnapshot(summary: IssueContinuationSummaryDocument) {
  return {
    key: summary.key,
    title: summary.title,
    body: summary.body,
    sourceTrust: summary.sourceTrust ?? null,
    updatedAt: summary.updatedAt.toISOString(),
    documentId: summary.documentId,
    revisionId: summary.latestRevisionId,
  };
}

/**
 * The summary snapshot carried by a queued run. Exactly one container is read
 * (the top-level copy, else the wake payload's copy); its fields are never
 * combined with the other container's.
 */
export function readQueuedContinuationSummary(context: Record<string, unknown>): HeldContinuationSummary | null {
  for (const container of [
    asRecord(context.paperclipContinuationSummary),
    asRecord(asRecord(context.paperclipWake).continuationSummary),
  ]) {
    const body = typeof container.body === "string" && container.body.trim().length > 0 ? container.body : null;
    if (!body) continue;
    return { body, documentId: asNonEmptyString(container.documentId), revisionId: asNonEmptyString(container.revisionId) };
  }
  return null;
}

/**
 * Body, time and writer of one immutable summary revision, or null when the
 * identity is absent or is not a revision of this issue's continuation summary.
 */
export async function resolveContinuationSummaryRevision(
  db: Db,
  input: { companyId: string; issueId: string; documentId: string | null; revisionId: string | null },
) {
  if (!input.documentId || !input.revisionId) return null;
  if (!UUID_RE.test(input.documentId) || !UUID_RE.test(input.revisionId)) return null;
  const [row] = await db
    .select({ body: documentRevisions.body, createdAt: documentRevisions.createdAt, createdByRunId: documentRevisions.createdByRunId })
    .from(documentRevisions)
    .innerJoin(issueDocuments, and(
      eq(issueDocuments.documentId, documentRevisions.documentId),
      eq(issueDocuments.companyId, documentRevisions.companyId),
    ))
    .where(and(
      eq(documentRevisions.id, input.revisionId),
      eq(documentRevisions.documentId, input.documentId),
      eq(documentRevisions.companyId, input.companyId),
      eq(issueDocuments.issueId, input.issueId),
      eq(issueDocuments.key, ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY),
    ))
    .limit(1);
  return row ? { body: row.body, writtenAt: row.createdAt, writerRunId: row.createdByRunId } : null;
}

/**
 * Whether a held summary parks the executor in the current stage. The same
 * rule applies to the live document and to either queued snapshot: body, time
 * and writer all come from the one identified revision. A summary describes the
 * stage it was written in, so a later status change by anyone but its writer
 * opens a new stage it cannot park. Unknown provenance never establishes such a
 * change, so the park stands.
 */
export async function continuationSummaryParksCurrentStage(
  db: Db,
  input: { companyId: string; issueId: string; summary: HeldContinuationSummary | null },
): Promise<{ body: string | null; parks: boolean }> {
  if (!input.summary) return { body: null, parks: false };
  const revision = await resolveContinuationSummaryRevision(db, {
    companyId: input.companyId,
    issueId: input.issueId,
    documentId: input.summary.documentId,
    revisionId: input.summary.revisionId,
  });
  const body = revision?.body ?? input.summary.body;
  if (!continuationSummaryParksExecutor(body)) return { body, parks: false };
  if (!revision?.writerRunId) return { body, parks: true };
  const newStage = await issueStatusChangedSince(db, {
    companyId: input.companyId,
    issueId: input.issueId,
    since: revision.writtenAt,
    excludeRunId: revision.writerRunId,
  });
  return { body, parks: !newStage };
}

export function buildContinuationSummaryMarkdown(input: {
  issue: IssueSummaryInput;
  run: RunSummaryInput;
  agent: AgentSummaryInput;
  previousSummaryBody?: string | null;
}) {
  const { issue, run, agent } = input;
  const resultSummary = readResultSummary(run.resultJson);
  const terminalFailure = run.resultJson?.terminalSessionFailure;
  const terminalFailureCategory = terminalFailure && typeof terminalFailure === "object" && !Array.isArray(terminalFailure)
    ? ((terminalFailure as Record<string, unknown>).category ?? "unknown")
    : null;
  const modelError = summarizeRunErrorForModel(run.error, terminalFailureCategory);
  const recentActions = [
    `Run \`${run.id}\` finished with status \`${run.status}\`${run.finishedAt ? ` at ${run.finishedAt.toISOString()}` : ""}.`,
    resultSummary ? truncateText(resultSummary, SUMMARY_SECTION_MAX_CHARS) : "No adapter-provided result summary was captured for this run.",
  ];
  if (modelError) {
    recentActions.push(`Latest run error${run.errorCode ? ` (${run.errorCode})` : ""}: ${truncateText(modelError, 500)}`);
  }

  const paths = extractPathCandidates(resultSummary, run.stdoutExcerpt, run.stderrExcerpt, input.previousSummaryBody);
  const objective = extractMarkdownSection(issue.description, "Objective") ?? issue.description?.trim() ?? "No objective captured.";
  const acceptanceCriteria = extractMarkdownSection(issue.description, "Acceptance Criteria") ?? "No explicit acceptance criteria captured.";
  const mode = inferMode(issue, run);
  const nextAction = inferNextAction(issue, run, extractPreviousNextAction(input.previousSummaryBody));

  const body = [
    "# Continuation Summary",
    "",
    `- Issue: ${issue.identifier ?? issue.id} — ${issue.title}`,
    `- Status: ${issue.status}`,
    `- Priority: ${issue.priority}`,
    `- Current mode: ${mode}`,
    `- Last updated by run: ${run.id}`,
    `- Agent: ${agent.name} (${agent.adapterType ?? "unknown"})`,
    "",
    "## Objective",
    "",
    truncateText(objective, SUMMARY_SECTION_MAX_CHARS),
    "",
    "## Acceptance Criteria",
    "",
    acceptanceCriteria,
    "",
    "## Recent Concrete Actions",
    "",
    bulletList(recentActions, "No recent actions captured."),
    "",
    "## Files / Routes Touched",
    "",
    bulletList(paths.map((path) => `\`${path}\``), "No file or route paths were detected in the captured run summary."),
    "",
    "## Commands Run",
    "",
    bulletList(
      [
        `Heartbeat run \`${run.id}\` invoked adapter \`${agent.adapterType ?? "unknown"}\`.`,
        "Detailed shell/tool commands remain in the run log and transcript.",
      ],
      "No command metadata captured.",
    ),
    "",
    "## Blockers / Decisions",
    "",
    bulletList(
      run.error
        ? [`Latest run ended with \`${run.status}\`; inspect the error before continuing.`]
        : ["No new blocker was recorded by the latest run."],
      "No blockers or decisions captured.",
    ),
    "",
    "## Next Action",
    "",
    `- ${nextAction}`,
  ].join("\n");

  return truncateText(body, ISSUE_CONTINUATION_SUMMARY_MAX_BODY_CHARS);
}

export async function getIssueContinuationSummaryDocument(
  db: Db,
  issueId: string,
): Promise<IssueContinuationSummaryDocument | null> {
  const row = await db
    .select({
      key: issueDocuments.key,
      title: documents.title,
      body: documents.latestBody,
      documentId: documents.id,
      latestRevisionId: documents.latestRevisionId,
      latestRevisionNumber: documents.latestRevisionNumber,
      sourceTrust: documents.sourceTrust,
      updatedAt: documents.updatedAt,
    })
    .from(issueDocuments)
    .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
    .where(and(eq(issueDocuments.issueId, issueId), eq(issueDocuments.key, ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY)))
    .then((rows) => rows[0] ?? null);

  if (!row) return null;
  return {
    key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
    title: row.title,
    body: row.body,
    documentId: row.documentId,
    latestRevisionId: row.latestRevisionId,
    latestRevisionNumber: row.latestRevisionNumber,
    sourceTrust: row.sourceTrust ?? null,
    updatedAt: row.updatedAt,
  };
}

export async function refreshIssueContinuationSummary(input: {
  db: Db;
  issueId: string;
  run: RunSummaryInput;
  agent: AgentSummaryInput;
}) {
  const { db, issueId, run, agent } = input;
  const [issue, existing] = await Promise.all([
    db
      .select({
        id: issues.id,
        conversationAgentId: issues.conversationAgentId,
        identifier: issues.identifier,
        title: issues.title,
        description: issues.description,
        status: issues.status,
        priority: issues.priority,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null),
    getIssueContinuationSummaryDocument(db, issueId),
  ]);

  if (!issue || issue.conversationAgentId) return null;
  const body = buildContinuationSummaryMarkdown({
    issue,
    run,
    agent,
    previousSummaryBody: existing?.body ?? null,
  });
  const result = await documentService(db).upsertIssueDocument({
    issueId,
    key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
    title: ISSUE_CONTINUATION_SUMMARY_TITLE,
    format: "markdown",
    body,
    baseRevisionId: existing?.latestRevisionId ?? null,
    changeSummary: `Refresh continuation summary after run ${run.id}`,
    createdByAgentId: agent.id,
    createdByRunId: run.id,
  });
  return result.document;
}
