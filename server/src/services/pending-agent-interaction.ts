import { issueThreadInteractions, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { canonicalizeStoredResolverPolicy } from "./issue-thread-interaction-resolution.js";

type Interaction = typeof issueThreadInteractions.$inferSelect;
type AddressedInteraction = Pick<Interaction,
  "id" | "companyId" | "issueId" | "kind" | "status" | "sourceRunId" |
  "addresseeAgentId" | "addresseeUserId" | "effectiveResolverPolicy" |
  "resolverPolicyProvenance" | "createdByAgentId" | "payload">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isPendingAgentInteractionAddressee(input: {
  companyId: string; issueId: string; agentId: string;
  contextSnapshot: Record<string, unknown>; interaction: AddressedInteraction | null;
}): boolean {
  const { interaction: row, contextSnapshot: context } = input;
  if (context.source !== "issue.interaction.created" ||
      context.wakeReason !== "interaction_pending" ||
      context.interactionKind !== "request_confirmation" ||
      typeof context.interactionId !== "string" || !UUID.test(context.interactionId) ||
      typeof context.sourceRunId !== "string" || !UUID.test(context.sourceRunId)) return false;
  if (!row || row.id !== context.interactionId ||
      row.companyId !== input.companyId || row.issueId !== input.issueId ||
      row.kind !== "request_confirmation" || row.status !== "pending" ||
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

/**
 * Re-read the persisted invitation at every dispatch boundary. This authorizes
 * only the named response participant, never checkout, reassignment, source work,
 * acceptance of a stale target, or a governed action. Those API gates still run.
 * Lock the invitation through the caller transaction's provider handoff so a
 * concurrent cancellation cannot revoke authority between read and dispatch.
 * A payload flag or a wake reason alone is never authority.
 */
export async function pendingAgentInteractionAddressee(db: Db, input: {
  companyId: string; issueId: string; agentId: string;
  contextSnapshot: Record<string, unknown>;
}): Promise<boolean> {
  const context = input.contextSnapshot;
  if (context.source !== "issue.interaction.created" ||
      context.wakeReason !== "interaction_pending" ||
      context.interactionKind !== "request_confirmation" ||
      typeof context.interactionId !== "string" || !UUID.test(context.interactionId) ||
      typeof context.sourceRunId !== "string" || !UUID.test(context.sourceRunId)) return false;
  const interaction = await db.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.id, context.interactionId),
    eq(issueThreadInteractions.companyId, input.companyId),
    eq(issueThreadInteractions.issueId, input.issueId),
  )).limit(1).for("update").then(rows => rows[0] ?? null);
  return isPendingAgentInteractionAddressee({ ...input, interaction });
}
