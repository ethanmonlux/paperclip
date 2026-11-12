import { describe, expect, it } from "vitest";
import {
  buildStapleConsoleBoard,
  deriveStapleConsoleClaim,
  parseStapleConsoleCapabilityMap,
  stapleConsoleDisplayName,
  type StapleConsoleCapabilityMapClaim,
  type StapleConsoleClaimLookups,
  type StapleConsoleClaimTaskFacts,
  type StapleConsoleInput,
  type StapleConsoleIssueInput,
  type StapleConsoleProofPullRequest,
} from "./staple-console.js";

const NOW = "2026-11-09T15:00:00.000Z";
const nowMs = Date.parse(NOW);
const minutesAgo = (minutes: number) => new Date(nowMs - minutes * 60_000).toISOString();

function issue(overrides: Partial<StapleConsoleIssueInput> & { id: string }): StapleConsoleIssueInput {
  return {
    identifier: overrides.id.toUpperCase(),
    title: `Task ${overrides.id}`,
    status: "todo",
    parentId: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    createdAt: minutesAgo(600),
    startedAt: null,
    completedAt: null,
    updatedAt: minutesAgo(600),
    monitorNextCheckAt: null,
    ...overrides,
  };
}

function boardInput(overrides: Partial<StapleConsoleInput>): StapleConsoleInput {
  return {
    now: NOW,
    issuePrefix: "STA",
    issues: [],
    agents: [
      { id: "coord", name: "Portfolio Coordinator", role: "general" },
      { id: "eng", name: "Portfolio Engineer", role: "engineer" },
    ],
    relations: [],
    runs: [],
    wakes: [],
    interactions: [],
    approvals: [],
    pullRequests: [],
    scheduled: [],
    sources: { github: { available: true, detail: "test" } },
    ...overrides,
  };
}

const mergedPr: StapleConsoleProofPullRequest = {
  label: "paperclip#40", url: "https://github.com/ethanmonlux/paperclip/pull/40", state: "merged",
  mergedAt: minutesAgo(90), mergeCommitSha: "abc1234def", ci: "success", source: "github", inInstalledBuild: true,
};

function facts(overrides: Partial<StapleConsoleClaimTaskFacts> & { identifier: string }): StapleConsoleClaimTaskFacts {
  return {
    name: overrides.identifier, status: "in_progress", terminal: false, owned: true, stuckReason: null,
    needsEthanReason: null, cardId: null, pullRequests: [], reviews: [], ...overrides,
  };
}

function lookups(tasks: StapleConsoleClaimTaskFacts[]): StapleConsoleClaimLookups {
  return { task: (identifier) => tasks.find((task) => task.identifier === identifier) ?? null, pullRequest: () => null };
}

const claim = (overrides: Partial<StapleConsoleCapabilityMapClaim> = {}): StapleConsoleCapabilityMapClaim => ({
  text: "Tasks wake when their blocker lands", why: "Blocked tasks sat idle after their blocker merged.", issues: ["STA-1"], ...overrides,
});

describe("capability claim colors (FAC-620 v2)", () => {
  it("renders a stated green without a merged PR as blue, never green", () => {
    const derived = deriveStapleConsoleClaim("c", claim({ override: { state: "green", reason: "Seen working" } }),
      lookups([facts({ identifier: "STA-1", status: "done", terminal: true })]));
    expect(derived.state).toBe("blue");
    expect(derived.stateReason).toContain("no merged PR proves it");
  });

  it("is green only with a merged PR, plus recorded acceptance when the claim needs it", () => {
    const done = facts({ identifier: "STA-1", status: "done", terminal: true, pullRequests: [mergedPr] });
    expect(deriveStapleConsoleClaim("c", claim(), lookups([done])).state).toBe("green");
    const unaccepted = deriveStapleConsoleClaim("c", claim({ needsAcceptance: true }), lookups([done]));
    expect(unaccepted.state).not.toBe("green");
    const overridden = deriveStapleConsoleClaim("c", claim({ needsAcceptance: true, override: { state: "green", reason: "Looks right" } }), lookups([done]));
    expect(overridden.state).toBe("blue");
    expect(overridden.stateReason).toContain("acceptance is not recorded");
    const accepted = deriveStapleConsoleClaim("c", claim({ needsAcceptance: true, acceptance: { evidence: ["https://example.test/shot.png"] } }), lookups([done]));
    expect(accepted.state).toBe("green");
    expect(accepted.proof.pullRequests).toEqual([mergedPr]);
  });

  it("is blue while someone is actively on the gap", () => {
    expect(deriveStapleConsoleClaim("c", claim(), lookups([facts({ identifier: "STA-1" })])).state).toBe("blue");
  });

  it("stays blue when a healthy fix is in flight beside a stuck defect or a waiting task", () => {
    const mixed = deriveStapleConsoleClaim("c", claim({ issues: ["STA-1", "STA-4"], defects: ["STA-2"] }), lookups([
      facts({ identifier: "STA-1" }),
      facts({ identifier: "STA-2", status: "todo", stuckReason: "No run in 45 min" }),
      facts({ identifier: "STA-4", needsEthanReason: "Ship it?" }),
    ]));
    expect(mixed.state).toBe("blue");
    expect(mixed.stateReason).toBe("STA-1 is on it; STA-4 waits on Ethan: Ship it?");
    expect(mixed.tasks.find((task) => task.identifier === "STA-2")).toMatchObject({ defect: true });
  });

  it("is red when nothing is fixing it: no owner, stuck, waiting on Ethan, or an open defect alone", () => {
    expect(deriveStapleConsoleClaim("c", claim(), lookups([facts({ identifier: "STA-1", owned: false })])).state).toBe("red");
    const stuck = deriveStapleConsoleClaim("c", claim({ issues: ["STA-2", "STA-3"] }), lookups([
      facts({ identifier: "STA-2", stuckReason: "No run in 45 min" }),
      facts({ identifier: "STA-3", owned: false }),
    ]));
    expect(stuck.state).toBe("red");
    expect(stuck.stateReason).toBe("STA-2 is stuck: No run in 45 min");
    expect(deriveStapleConsoleClaim("c", claim(), lookups([facts({ identifier: "STA-1", needsEthanReason: "Ship it?" })])).state).toBe("red");
    const defect = deriveStapleConsoleClaim("c", claim({ issues: [], defects: ["STA-9"] }), lookups([
      facts({ identifier: "STA-9", status: "todo", owned: false }),
    ]));
    expect(defect.state).toBe("red");
    expect(defect.tasks[0]).toMatchObject({ identifier: "STA-9", defect: true });
  });
});

describe("parseStapleConsoleCapabilityMap", () => {
  it("reads the fenced JSON block and drops malformed entries one by one", () => {
    const parsed = parseStapleConsoleCapabilityMap([
      "# Capability map",
      "```json",
      JSON.stringify({
        version: 2,
        groups: [
          { key: "staple", label: "Staple, building itself", capabilities: [
            { key: "cycling", title: "Keeps cycling", claims: [claim(), { why: "no text" }, { text: "  " }] },
            { title: 5 },
          ] },
          "not a group",
        ],
        names: { "STA-214": "Console v2 layout", "STA-1": 7 },
      }),
      "```",
    ].join("\n"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.map.version).toBe(2);
    expect(parsed.map.groups).toHaveLength(1);
    expect(parsed.map.groups[0]!.capabilities).toHaveLength(1);
    expect(parsed.map.groups[0]!.capabilities[0]!.claims.map((entry) => entry.text)).toEqual(["Tasks wake when their blocker lands"]);
    expect(parsed.map.names).toEqual({ "STA-214": "Console v2 layout" });
  });

  it("reports a body with no readable groups as an error", () => {
    expect(parseStapleConsoleCapabilityMap("no json here")).toMatchObject({ ok: false });
    expect(parseStapleConsoleCapabilityMap("{\"groups\": []}")).toMatchObject({ ok: false });
  });
});

describe("Level 1 needs attention and plain names", () => {
  it("pins founder questions first, then stuck work, then Done work whose PR nobody merges", () => {
    const board = buildStapleConsoleBoard(boardInput({
      issues: [
        issue({ id: "s", identifier: "STA-10", title: "FAC-818: Backpack art", status: "in_progress", startedAt: minutesAgo(120), assigneeAgentId: "eng" }),
        issue({ id: "q", identifier: "STA-11", title: "FAC-830: Item art trees", status: "in_progress", assigneeAgentId: "eng" }),
        issue({ id: "d", identifier: "STA-12", title: "FAC-829: Content packs", status: "done", completedAt: minutesAgo(30), assigneeAgentId: "coord" }),
        issue({ id: "ok", identifier: "STA-13", title: "STA-13 source | Quiet work", status: "todo", assigneeAgentId: "eng" }),
      ],
      runs: [{ id: "r", issueId: "q", agentId: "eng", status: "running", createdAt: minutesAgo(5), startedAt: minutesAgo(5), finishedAt: null, lastOutputAt: minutesAgo(1), errorCode: null, error: null }],
      interactions: [{ id: "i1", issueId: "q", kind: "ask_user_questions", status: "pending", question: "Ship the 3x art?", addresseeAgentId: null, createdAt: minutesAgo(5) }],
      pullRequests: [{
        issueId: "d", repo: "ethanmonlux/facette", number: 77, url: "https://github.com/ethanmonlux/facette/pull/77",
        state: "open", mergedAt: null, ci: "success", ciStartedAt: minutesAgo(40), source: "github",
      }],
    }));
    expect(board.attention.map((item) => [item.kind, item.identifier])).toEqual([
      ["needs_you", "STA-11"],
      ["stuck", "STA-10"],
      ["unowned_merge", "STA-12"],
    ]);
    expect(board.attention[0]).toMatchObject({ text: "Ship the 3x art?", linkLabel: "Answer", href: "/issues/STA-11#interaction-i1" });
    expect(board.attention[2]).toMatchObject({ href: "https://github.com/ethanmonlux/facette/pull/77", linkLabel: "Open PR" });
    const quiet = board.lanes.flatMap((lane) => lane.cards).find((card) => card.identifier === "STA-13")!;
    expect(quiet.name).toBe("Quiet work");
    expect(quiet.shipped).toBe(false);
  });

  it("is empty when nothing needs Ethan and nothing is stalled", () => {
    const board = buildStapleConsoleBoard(boardInput({
      issues: [issue({ id: "a", identifier: "STA-1", status: "todo", assigneeAgentId: "eng" })],
    }));
    expect(board.attention).toEqual([]);
    expect(board.capabilities.source.available).toBe(false);
  });

  it("links claims to their board cards and uses the map's plain feature names", () => {
    const board = buildStapleConsoleBoard(boardInput({
      issues: [issue({ id: "a", identifier: "STA-214", title: "Staple Console v2: progressive-depth layout (glance, capabilities) (FAC-620)", status: "in_progress", assigneeAgentId: "eng" })],
      runs: [{ id: "r", issueId: "a", agentId: "eng", status: "running", createdAt: minutesAgo(5), startedAt: minutesAgo(5), finishedAt: null, lastOutputAt: minutesAgo(1), errorCode: null, error: null }],
      capabilityMap: {
        issueIdentifier: "STA-152", revisionNumber: 3, updatedAt: minutesAgo(10),
        body: JSON.stringify({ groups: [{ key: "staple", label: "Staple", capabilities: [{ key: "tells", title: "Tells you things", claims: [claim({ issues: ["STA-214"] })] }] }], names: { "STA-214": "Console v2 layout" } }),
      },
    }));
    const card = board.lanes.flatMap((lane) => lane.cards)[0]!;
    expect(card.name).toBe("Console v2 layout");
    expect(card.ownerName).toBe("Portfolio Engineer");
    const capability = board.capabilities.groups[0]!.capabilities[0]!;
    expect(capability.counts).toEqual({ green: 0, blue: 1, red: 0 });
    expect(capability.claims[0]!.cardIds).toEqual([card.id]);
    expect(board.capabilities.source.detail).toBe("STA-152 capability-map, revision 3");
  });

  it("turns raw task titles into plain feature names", () => {
    expect(stapleConsoleDisplayName("FAC-829: Content packs")).toBe("Content packs");
    expect(stapleConsoleDisplayName("FAC-626 source | Account bridge")).toBe("Account bridge");
    expect(stapleConsoleDisplayName("Staple Console v2: progressive-depth layout (glance, capabilities, work, proof) (FAC-620)"))
      .toBe("Staple Console v2: progressive-depth layout");
    expect(stapleConsoleDisplayName("STA-7")).toBe("STA-7");
  });
});
