import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isPendingAgentInteractionAddressee as permits } from "./pending-agent-interaction.js";

function fixture() {
  const companyId = randomUUID(), issueId = randomUUID(), agentId = randomUUID();
  const sourceRunId = randomUUID(), id = randomUUID();
  return { companyId, issueId, agentId,
    contextSnapshot: { source: "issue.interaction.created", wakeReason: "interaction_pending",
      interactionKind: "request_confirmation", interactionId: id, sourceRunId },
    interaction: { id, companyId, issueId, kind: "request_confirmation", status: "pending",
      sourceRunId, createdByAgentId: randomUUID(), addresseeAgentId: agentId, addresseeUserId: null,
      effectiveResolverPolicy: "anyone" as const, resolverPolicyProvenance: "inherited" as const,
      payload: { version: 1 as const, prompt: "Route the frozen source handoff." } },
  };
}

describe("pending agent interaction admission", () => {
  it("permits only the persisted named pending recipient", () => {
    const f = fixture();
    expect(permits(f)).toBe(true);
    expect(permits({ ...f, interaction: { ...f.interaction, effectiveResolverPolicy: "not_creator" } })).toBe(true);
    expect(permits({ ...f, interaction: null })).toBe(false);
  });
  it.each([
    ["id", randomUUID()], ["companyId", randomUUID()], ["issueId", randomUUID()],
    ["addresseeAgentId", randomUUID()], ["addresseeUserId", "human"],
    ["status", "accepted"], ["status", "rejected"], ["status", "cancelled"],
    ["sourceRunId", randomUUID()], ["kind", "choice"],
    ["effectiveResolverPolicy", "human_only"], ["effectiveResolverPolicy", "unknown"],
  ])("rejects an inconsistent persisted %s (%s)", (key, value) => {
    const f = fixture();
    expect(permits({ ...f, interaction: { ...f.interaction, [key]: value } } as unknown as Parameters<typeof permits>[0])).toBe(false);
  });
  it.each([
    ["source", "issue.comment.created"], ["wakeReason", "issue_assigned"],
    ["interactionKind", "choice"], ["interactionId", "malformed"], ["sourceRunId", null],
  ])("rejects mismatched wake %s", (key, value) => {
    const f = fixture();
    expect(permits({ ...f, contextSnapshot: { ...f.contextSnapshot, [key]: value } })).toBe(false);
  });
  it("rejects self invitations and governed or malformed payloads", () => {
    const f = fixture();
    expect(permits({ ...f, interaction: { ...f.interaction, createdByAgentId: f.agentId } })).toBe(false);
    for (const payload of [null, [], { toolAction: {} }, { secretProposal: {} }]) {
      expect(permits({ ...f, interaction: { ...f.interaction, payload } } as unknown as Parameters<typeof permits>[0])).toBe(false);
    }
  });
});
