import { eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issueLabels, labels } from "@paperclipai/db";
import { unprocessable } from "../errors.js";

/**
 * Capability-based task routing (FAC-840 C2).
 *
 * An agent opts in through `metadata.routing`:
 *   { "capabilities": ["kaia"], "exclusive": true }
 *
 * A routing label is a task label whose name matches a capability declared by
 * any opted-in agent. When work is assigned to an opted-in agent:
 * - it must declare every routing label on the task;
 * - if it is exclusive, the task must carry one of its capability labels.
 * Agents without `metadata.routing` (coordinators, reviewers) are not routed.
 */
export type AgentRoutingConfig = {
  capabilities: string[];
  exclusive: boolean;
};

export type ParsedAgentRouting =
  | { kind: "none" }
  | { kind: "config"; config: AgentRoutingConfig }
  | { kind: "invalid"; problem: string };

export type RoutingAgent = {
  id: string;
  name: string;
  status: string;
  metadata: Record<string, unknown> | null;
};

export type CapabilityRoutingRejectionReason =
  | "capability_missing"
  | "exclusive_label_missing"
  | "routing_config_invalid";

export type CapabilityRoutingDecision =
  | { allowed: true }
  | {
    allowed: false;
    reason: CapabilityRoutingRejectionReason;
    message: string;
    requiredCapabilities: string[];
    missingCapabilities: string[];
    eligibleAgents: Array<{ id: string; name: string }>;
  };

const UNASSIGNABLE_STATUSES = new Set(["terminated", "pending_approval"]);

function normalizeCapability(value: string) {
  return value.trim().toLowerCase();
}

export function parseAgentRouting(metadata: Record<string, unknown> | null | undefined): ParsedAgentRouting {
  const routing = metadata?.routing;
  if (routing === undefined || routing === null) return { kind: "none" };
  if (typeof routing !== "object" || Array.isArray(routing)) {
    return { kind: "invalid", problem: "metadata.routing must be an object" };
  }
  const record = routing as Record<string, unknown>;
  const rawCapabilities = record.capabilities;
  if (!Array.isArray(rawCapabilities) || rawCapabilities.some((entry) => typeof entry !== "string")) {
    return { kind: "invalid", problem: "metadata.routing.capabilities must be a list of names" };
  }
  const capabilities = [...new Set(rawCapabilities.map((entry) => normalizeCapability(entry as string)).filter(Boolean))];
  if (record.exclusive !== undefined && typeof record.exclusive !== "boolean") {
    return { kind: "invalid", problem: "metadata.routing.exclusive must be true or false" };
  }
  const exclusive = record.exclusive === true;
  if (exclusive && capabilities.length === 0) {
    return { kind: "invalid", problem: "an exclusive agent must declare at least one capability" };
  }
  return { kind: "config", config: { capabilities, exclusive } };
}

function quoteList(values: string[], joiner: "and" | "or") {
  const quoted = values.map((value) => `"${value}"`);
  if (quoted.length <= 1) return quoted.join("");
  return `${quoted.slice(0, -1).join(", ")} ${joiner} ${quoted[quoted.length - 1]}`;
}

function nameList(entries: Array<{ name: string }>) {
  return entries.map((entry) => entry.name).join(", ");
}

function checkConfig(config: AgentRoutingConfig, requiredCapabilities: string[]) {
  const missing = requiredCapabilities.filter((capability) => !config.capabilities.includes(capability));
  const exclusiveUnmet = config.exclusive
    && !config.capabilities.some((capability) => requiredCapabilities.includes(capability));
  return { missing, exclusiveUnmet };
}

export function evaluateCapabilityRouting(input: {
  assignee: RoutingAgent;
  agents: RoutingAgent[];
  labelNames: string[];
}): CapabilityRoutingDecision {
  const assigneeRouting = parseAgentRouting(input.assignee.metadata);
  if (assigneeRouting.kind === "none") return { allowed: true };

  const configured = input.agents
    .filter((agent) => agent.id !== input.assignee.id)
    .map((agent) => ({ agent, routing: parseAgentRouting(agent.metadata) }))
    .flatMap((entry) => (entry.routing.kind === "config" ? [{ agent: entry.agent, config: entry.routing.config }] : []));
  const declared = new Set(configured.flatMap((entry) => entry.config.capabilities));
  if (assigneeRouting.kind === "config") {
    for (const capability of assigneeRouting.config.capabilities) declared.add(capability);
  }
  const requiredCapabilities = [...new Set(input.labelNames.map(normalizeCapability))]
    .filter((name) => declared.has(name))
    .sort();
  const eligibleAgents = configured
    .filter((entry) => !UNASSIGNABLE_STATUSES.has(entry.agent.status))
    .filter((entry) => {
      const result = checkConfig(entry.config, requiredCapabilities);
      return result.missing.length === 0 && !result.exclusiveUnmet;
    })
    .map((entry) => ({ id: entry.agent.id, name: entry.agent.name }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const elsewhere = eligibleAgents.length > 0
    ? `assign it to ${nameList(eligibleAgents)}`
    : "no configured agent can take it as labelled, so fix the task labels or agent routing";

  if (assigneeRouting.kind === "invalid") {
    return {
      allowed: false,
      reason: "routing_config_invalid",
      message: `${input.assignee.name} has an invalid routing configuration (${assigneeRouting.problem}). `
        + `Fix the agent's routing configuration, or ${elsewhere}.`,
      requiredCapabilities,
      missingCapabilities: [],
      eligibleAgents,
    };
  }

  const { missing, exclusiveUnmet } = checkConfig(assigneeRouting.config, requiredCapabilities);
  if (missing.length > 0) {
    return {
      allowed: false,
      reason: "capability_missing",
      message: `This task is labelled ${quoteList(missing, "and")}, which ${input.assignee.name} does not handle. `
        + `${elsewhere.charAt(0).toUpperCase()}${elsewhere.slice(1)}, or remove the label if it does not apply.`,
      requiredCapabilities,
      missingCapabilities: missing,
      eligibleAgents,
    };
  }
  if (exclusiveUnmet) {
    const own = assigneeRouting.config.capabilities;
    return {
      allowed: false,
      reason: "exclusive_label_missing",
      message: `${input.assignee.name} only takes tasks labelled ${quoteList(own, "or")}, and this task has no such label. `
        + `If it is that work, add the label; otherwise ${elsewhere}.`,
      requiredCapabilities,
      missingCapabilities: [],
      eligibleAgents,
    };
  }
  return { allowed: true };
}

async function loadLabelNames(
  db: Db,
  companyId: string,
  source: { labelIds: string[] } | { issueId: string },
) {
  if ("labelIds" in source) {
    if (source.labelIds.length === 0) return [];
    const rows = await db
      .select({ name: labels.name, companyId: labels.companyId })
      .from(labels)
      .where(inArray(labels.id, [...new Set(source.labelIds)]));
    return rows.filter((row) => row.companyId === companyId).map((row) => row.name);
  }
  const rows = await db
    .select({ name: labels.name, companyId: labels.companyId })
    .from(issueLabels)
    .innerJoin(labels, eq(issueLabels.labelId, labels.id))
    .where(eq(issueLabels.issueId, source.issueId));
  return rows.filter((row) => row.companyId === companyId).map((row) => row.name);
}

/**
 * Rejects an assignment that the agents' declared routing does not allow.
 * Call it only when the assignee changes, so existing work stays claimable.
 */
export async function assertCapabilityRouting(
  db: Db,
  input: {
    companyId: string;
    assigneeAgentId: string | null | undefined;
    labels: { labelIds: string[] } | { issueId: string };
  },
) {
  if (!input.assigneeAgentId) return;
  const companyAgents: RoutingAgent[] = await db
    .select({ id: agents.id, name: agents.name, status: agents.status, metadata: agents.metadata })
    .from(agents)
    .where(eq(agents.companyId, input.companyId));
  const assignee = companyAgents.find((agent) => agent.id === input.assigneeAgentId);
  if (!assignee || parseAgentRouting(assignee.metadata).kind === "none") return;

  const labelNames = await loadLabelNames(db, input.companyId, input.labels);
  const decision = evaluateCapabilityRouting({ assignee, agents: companyAgents, labelNames });
  if (decision.allowed) return;
  throw unprocessable(decision.message, {
    code: "agent_capability_mismatch",
    reason: decision.reason,
    companyId: input.companyId,
    assigneeAgentId: assignee.id,
    requiredCapabilities: decision.requiredCapabilities,
    missingCapabilities: decision.missingCapabilities,
    eligibleAgents: decision.eligibleAgents,
  });
}
