import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issueLabels, issues, labels } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { evaluateCapabilityRouting, parseAgentRouting, type RoutingAgent } from "./capability-routing.js";
import { issueService } from "./issues.js";

// The portfolio lanes as configured for FAC-840 C2.
const portfolio: RoutingAgent = {
  id: "portfolio", name: "Portfolio Engineer", status: "idle",
  metadata: { routing: { capabilities: ["portfolio"] } },
};
const kaia: RoutingAgent = {
  id: "kaia", name: "Portfolio Engineer - Kaia", status: "idle",
  metadata: { portfolioLane: "Kaia / Ember Vault / gear selector", routing: { capabilities: ["kaia"], exclusive: true } },
};
const account: RoutingAgent = {
  id: "account", name: "Portfolio Engineer - Account", status: "idle",
  metadata: { routing: { capabilities: ["account"], exclusive: true } },
};
const coordinator: RoutingAgent = { id: "coordinator", name: "Portfolio Coordinator", status: "idle", metadata: null };
const lanes = [portfolio, kaia, account, coordinator];

function route(assignee: RoutingAgent, labelNames: string[], agentsList: RoutingAgent[] = lanes) {
  return evaluateCapabilityRouting({ assignee, agents: agentsList, labelNames });
}

describe("capability routing policy", () => {
  it("rejects STA-151: unlabelled boss-name work routed to the Kaia-only engineer", () => {
    const decision = route(kaia, []);
    expect(decision).toMatchObject({
      allowed: false,
      reason: "exclusive_label_missing",
      eligibleAgents: [{ id: "portfolio", name: "Portfolio Engineer" }],
    });
    expect(decision.allowed ? "" : decision.message).toBe(
      "Portfolio Engineer - Kaia only takes tasks labelled \"kaia\", and this task has no such label. "
        + "If it is that work, add the label; otherwise assign it to Portfolio Engineer.",
    );
  });

  it("rejects an unrelated label on Kaia-only work just like no label", () => {
    expect(route(kaia, ["bug", "Ember Vault"])).toMatchObject({ allowed: false, reason: "exclusive_label_missing" });
  });

  it("routes Kaia work to the Kaia engineer, matching label names case-insensitively", () => {
    expect(route(kaia, ["kaia"])).toEqual({ allowed: true });
    expect(route(kaia, [" Kaia ", "bug"])).toEqual({ allowed: true });
  });

  it("keeps Kaia work off the general Portfolio and Account engineers", () => {
    expect(route(portfolio, ["kaia"])).toMatchObject({
      allowed: false,
      reason: "capability_missing",
      missingCapabilities: ["kaia"],
      eligibleAgents: [{ id: "kaia", name: "Portfolio Engineer - Kaia" }],
    });
    const decision = route(portfolio, ["kaia"]);
    expect(decision.allowed ? "" : decision.message).toBe(
      "This task is labelled \"kaia\", which Portfolio Engineer does not handle. "
        + "Assign it to Portfolio Engineer - Kaia, or remove the label if it does not apply.",
    );
    expect(route(account, ["kaia"])).toMatchObject({ allowed: false, reason: "capability_missing" });
  });

  it("routes Account work only to the Account engineer", () => {
    expect(route(account, ["account"])).toEqual({ allowed: true });
    expect(route(account, [])).toMatchObject({
      allowed: false,
      reason: "exclusive_label_missing",
      eligibleAgents: [{ id: "portfolio", name: "Portfolio Engineer" }],
    });
    expect(route(portfolio, ["account"])).toMatchObject({
      allowed: false,
      reason: "capability_missing",
      eligibleAgents: [{ id: "account", name: "Portfolio Engineer - Account" }],
    });
    expect(route(kaia, ["account"])).toMatchObject({ allowed: false, reason: "capability_missing" });
  });

  it("routes all other work to the general Portfolio engineer", () => {
    expect(route(portfolio, [])).toEqual({ allowed: true });
    expect(route(portfolio, ["bug"])).toEqual({ allowed: true });
    expect(route(portfolio, ["portfolio"])).toEqual({ allowed: true });
  });

  it("leaves agents without routing config unrouted", () => {
    expect(route(coordinator, ["kaia"])).toEqual({ allowed: true });
    expect(route(coordinator, [])).toEqual({ allowed: true });
  });

  it("names no eligible agent when a label combination has no owner", () => {
    const decision = route(kaia, ["kaia", "account"]);
    expect(decision).toMatchObject({ allowed: false, reason: "capability_missing", eligibleAgents: [] });
    expect(decision.allowed ? "" : decision.message).toContain(
      "No configured agent can take it as labelled, so fix the task labels or agent routing",
    );
  });

  it("does not suggest terminated or pending agents", () => {
    const retiredPortfolio = { ...portfolio, status: "terminated" };
    expect(route(kaia, [], [retiredPortfolio, kaia, account])).toMatchObject({ allowed: false, eligibleAgents: [] });
  });

  it("rejects work for an agent whose routing config is malformed", () => {
    const broken: RoutingAgent = { ...kaia, metadata: { routing: { capabilities: "kaia" } } };
    expect(route(broken, ["kaia"], [portfolio, broken])).toMatchObject({ allowed: false, reason: "routing_config_invalid" });
  });

  it("parses routing config strictly", () => {
    expect(parseAgentRouting(null)).toEqual({ kind: "none" });
    expect(parseAgentRouting({ portfolioLane: "prose only" })).toEqual({ kind: "none" });
    expect(parseAgentRouting({ routing: { capabilities: ["Kaia", "kaia", " "] } }))
      .toEqual({ kind: "config", config: { capabilities: ["kaia"], exclusive: false } });
    expect(parseAgentRouting({ routing: { capabilities: [], exclusive: true } })).toMatchObject({ kind: "invalid" });
    expect(parseAgentRouting({ routing: { capabilities: ["kaia"], exclusive: "yes" } })).toMatchObject({ kind: "invalid" });
    expect(parseAgentRouting({ routing: [] })).toMatchObject({ kind: "invalid" });
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("issueService capability routing", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-capability-routing-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueLabels);
    await db.delete(issues);
    await db.delete(labels);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedLanes() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Portfolio",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const ids = { portfolio: randomUUID(), kaia: randomUUID(), account: randomUUID(), coordinator: randomUUID() };
    const row = (id: string, name: string, metadata: Record<string, unknown> | null) => ({
      id, companyId, name, role: "engineer", status: "active", adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: {}, permissions: {}, metadata,
    });
    await db.insert(agents).values([
      row(ids.portfolio, "Portfolio Engineer", portfolio.metadata),
      row(ids.kaia, "Portfolio Engineer - Kaia", kaia.metadata),
      row(ids.account, "Portfolio Engineer - Account", account.metadata),
      row(ids.coordinator, "Portfolio Coordinator", null),
    ]);
    const kaiaLabelId = randomUUID();
    await db.insert(labels).values({ id: kaiaLabelId, companyId, name: "kaia", color: "#aa66cc" });
    return { companyId, ids, kaiaLabelId };
  }

  const mismatch = (reason: string) => ({
    status: 422,
    details: expect.objectContaining({ code: "agent_capability_mismatch", reason }),
  });

  it("rejects creating STA-151-style work for the Kaia-only engineer and accepts labelled Kaia work", async () => {
    const { companyId, ids, kaiaLabelId } = await seedLanes();
    await expect(svc.create(companyId, {
      title: "Show reported Slayer boss and area in Ember Vault",
      status: "todo",
      priority: "high",
      assigneeAgentId: ids.kaia,
    })).rejects.toMatchObject(mismatch("exclusive_label_missing"));
    expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(0);

    await expect(svc.create(companyId, {
      title: "Kaia gear selector art",
      status: "todo",
      priority: "high",
      assigneeAgentId: ids.kaia,
      labelIds: [kaiaLabelId],
    })).resolves.toMatchObject({ assigneeAgentId: ids.kaia });
  });

  it("rejects a reassignment to the wrong lane and keeps the existing assignee", async () => {
    const { companyId, ids, kaiaLabelId } = await seedLanes();
    const issue = await svc.create(companyId, {
      title: "Boss names", status: "todo", priority: "high", assigneeAgentId: ids.portfolio,
    });
    await expect(svc.update(issue.id, { assigneeAgentId: ids.kaia })).rejects.toMatchObject(mismatch("exclusive_label_missing"));
    const [persisted] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(persisted?.assigneeAgentId).toBe(ids.portfolio);

    // Labelling the task as Kaia work in the same update routes it.
    await expect(svc.update(issue.id, { assigneeAgentId: ids.kaia, labelIds: [kaiaLabelId] }))
      .resolves.toMatchObject({ assigneeAgentId: ids.kaia });
    // Kaia-labelled work cannot then move to the general engineer.
    await expect(svc.update(issue.id, { assigneeAgentId: ids.portfolio })).rejects.toMatchObject(mismatch("capability_missing"));
    // Unrouted agents such as the Coordinator can still take it.
    await expect(svc.update(issue.id, { assigneeAgentId: ids.coordinator }))
      .resolves.toMatchObject({ assigneeAgentId: ids.coordinator });
  });

  it("keeps work already held by a routed agent claimable", async () => {
    const { companyId, ids } = await seedLanes();
    const issueId = randomUUID();
    // Assigned before routing was configured.
    await db.insert(issues).values({ id: issueId, companyId, title: "In-flight Kaia task", status: "todo", assigneeAgentId: ids.kaia });

    await expect(svc.update(issueId, { assigneeAgentId: ids.kaia, priority: "high" }))
      .resolves.toMatchObject({ assigneeAgentId: ids.kaia, priority: "high" });
    await expect(svc.checkout(issueId, ids.kaia, ["todo"], null))
      .resolves.toMatchObject({ assigneeAgentId: ids.kaia, status: "in_progress" });
  });

  it("routes a checkout that claims unassigned work", async () => {
    const { companyId, ids } = await seedLanes();
    const issue = await svc.create(companyId, { title: "Unassigned boss names", status: "todo", priority: "high" });
    await expect(svc.checkout(issue.id, ids.kaia, ["todo"], null)).rejects.toMatchObject(mismatch("exclusive_label_missing"));
    await expect(svc.checkout(issue.id, ids.portfolio, ["todo"], null))
      .resolves.toMatchObject({ assigneeAgentId: ids.portfolio });
  });
});
