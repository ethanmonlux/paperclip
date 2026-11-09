import { issueThreadInteractions, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { canonicalizeStoredResolverPolicy } from "./issue-thread-interaction-resolution.js";

type Interaction = typeof issueThreadInteractions.$inferSelect;
type AddressedInteraction = Pick<Interaction,
  "id" | "companyId" | "issueId" | "kind" | "status" | "sourceRunId" |
  "addresseeAgentId" | "addresseeUserId" | "effectiveResolverPolicy" |
  "resolverPolicyProvenance" | "createdByAgentId" | "payload">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Interaction kinds an addressed agent may act on from a task it does not own.
 * A Coordinator is asked questions, confirmations, verdicts and task
 * suggestions on its Engineer's child task. connection_intent is excluded: it
 * concerns credentials and stays with its own consent path.
 */
const ADDRESSABLE_AGENT_INTERACTION_KINDS: ReadonlySet<string> = new Set([
  "request_confirmation",
  "ask_user_questions",
  "request_checkbox_confirmation",
  "request_item_verdicts",
  "suggest_tasks",
]);

export function isPendingAgentInteractionAddressee(input: {
  companyId: string; issueId: string; agentId: string;
  contextSnapshot: Record<string, unknown>; interaction: AddressedInteraction | null;
}): boolean {
  const { interaction: row, contextSnapshot: context } = input;
  if (context.source !== "issue.interaction.created" ||
      context.wakeReason !== "interaction_pending" ||
      typeof context.interactionKind !== "string" ||
      !ADDRESSABLE_AGENT_INTERACTION_KINDS.has(context.interactionKind) ||
      typeof context.interactionId !== "string" || !UUID.test(context.interactionId) ||
      typeof context.sourceRunId !== "string" || !UUID.test(context.sourceRunId)) return false;
  if (!row || row.id !== context.interactionId ||
      row.companyId !== input.companyId || row.issueId !== input.issueId ||
      row.kind !== context.interactionKind || row.status !== "pending" ||
      row.addresseeAgentId !== input.agentId || row.addresseeUserId != null ||
      row.createdByAgentId === input.agentId ||
      row.sourceRunId !== context.sourceRunId) return false;
  if (!row.payload || typeof row.payload !== "object" || Array.isArray(row.payload)) return false;
  const payload = row.payload as unknown as Record<string, unknown>;
  if (payload.toolAction != null || payload.secretProposal != null) return false;
  if (!["anyone", "not_creator", "board_or_agents"].includes(row.effectiveResolverPolicy)) return false;
  const policy = canonicalizeStoredResolverPolicy(
    row.effectiveResolverPolicy, row.resolverPolicyProvenance,
  );
  return policy === "anyone" || policy === "not_creator";
}

export async function pendingAgentInteractionAddressee(db: Db, input: {
  companyId: string; issueId: string; agentId: string;
  contextSnapshot: Record<string, unknown>;
}): Promise<boolean> {
  const context = input.contextSnapshot;
  if (context.source !== "issue.interaction.created" ||
      context.wakeReason !== "interaction_pending" ||
      typeof context.interactionKind !== "string" ||
      !ADDRESSABLE_AGENT_INTERACTION_KINDS.has(context.interactionKind) ||
      typeof context.interactionId !== "string" || !UUID.test(context.interactionId) ||
      typeof context.sourceRunId !== "string" || !UUID.test(context.sourceRunId)) return false;
  const interaction = await db.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.id, context.interactionId),
    eq(issueThreadInteractions.companyId, input.companyId),
    eq(issueThreadInteractions.issueId, input.issueId),
  )).limit(1).for("update").then(rows => rows[0] ?? null);
  return isPendingAgentInteractionAddressee({ ...input, interaction });
}
