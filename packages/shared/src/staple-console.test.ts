import { describe, expect, it } from "vitest";
import {
  buildStapleConsoleBoard,
  extractFacIds,
  extractStapleConsolePrRefs,
  nextStapleConsoleLocalTime,
  stapleConsoleDefaultRepo,
  stapleConsoleFreshness,
  stuckBlockedWithoutBlocker,
  stuckInProgressIdle,
  stuckLongRun,
  stuckRepeatedFailure,
  stuckReviewIdle,
  type StapleConsoleInput,
  type StapleConsoleIssueInput,
  type StapleConsoleIssueRunContext,
  type StapleConsoleRunInput,
} from "./staple-console.js";

const NOW = "2026-11-09T15:00:00.000Z"; // 08:00 in Denver
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

function run(overrides: Partial<StapleConsoleRunInput> & { id: string; issueId: string }): StapleConsoleRunInput {
  return {
    agentId: "eng",
    status: "succeeded",
    createdAt: minutesAgo(60),
    startedAt: minutesAgo(60),
    finishedAt: minutesAgo(50),
    lastOutputAt: null,
    errorCode: null,
    error: null,
    ...overrides,
  };
}

function ctx(overrides: Partial<StapleConsoleIssueRunContext> & { issue: StapleConsoleIssueInput }): StapleConsoleIssueRunContext {
  return { runs: [], wakes: [], openBlockerCount: 0, pendingQuestionCount: 0, isReview: false, ...overrides };
}

const agents = [
  { id: "coord", name: "Portfolio Coordinator", role: "general" },
  { id: "eng", name: "Portfolio Engineer", role: "engineer" },
  { id: "rev", name: "Portfolio Reviewer", role: "qa" },
];

function boardInput(overrides: Partial<StapleConsoleInput>): StapleConsoleInput {
  return {
    now: NOW,
    issuePrefix: "STA",
    issues: [],
    agents,
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

describe("stuck rule 1: in progress, no run in 30 min, no wake scheduled", () => {
  const base = issue({ id: "a", status: "in_progress", startedAt: minutesAgo(120) });

  it("flags an idle in-progress task", () => {
    const flag = stuckInProgressIdle(ctx({ issue: base, runs: [run({ id: "r", issueId: "a", finishedAt: minutesAgo(45) })] }), nowMs);
    expect(flag?.rule).toBe("in_progress_idle");
    expect(flag?.reason).toBe("In progress, no run for 45 min and no wake scheduled");
  });

  it("does not flag recent run activity, an active run or a scheduled wake", () => {
    const recent = [run({ id: "r", issueId: "a", finishedAt: minutesAgo(10) })];
    expect(stuckInProgressIdle(ctx({ issue: base, runs: recent }), nowMs)).toBeNull();
    const running = [run({ id: "r", issueId: "a", status: "running", startedAt: minutesAgo(40), finishedAt: null })];
    expect(stuckInProgressIdle(ctx({ issue: base, runs: running }), nowMs)).toBeNull();
    const monitored = { ...base, monitorNextCheckAt: minutesAgo(-30) };
    expect(stuckInProgressIdle(ctx({ issue: monitored }), nowMs)).toBeNull();
    expect(stuckInProgressIdle(ctx({ issue: base, wakes: [{ issueId: "a", status: "queued", requestedAt: minutesAgo(1) }] }), nowMs)).toBeNull();
  });
});

describe("stuck rule 2: one run going for more than 90 min", () => {
  const base = issue({ id: "a", status: "in_progress" });

  it("flags a 95 minute run", () => {
    const flag = stuckLongRun(ctx({ issue: base, runs: [run({ id: "r", issueId: "a", status: "running", startedAt: minutesAgo(95), finishedAt: null })] }), nowMs);
    expect(flag?.rule).toBe("long_run");
    expect(flag?.reason).toBe("One run going for 1 h 35 min");
  });

  it("does not flag an 80 minute run or a long finished run", () => {
    expect(stuckLongRun(ctx({ issue: base, runs: [run({ id: "r", issueId: "a", status: "running", startedAt: minutesAgo(80), finishedAt: null })] }), nowMs)).toBeNull();
    expect(stuckLongRun(ctx({ issue: base, runs: [run({ id: "r", issueId: "a", startedAt: minutesAgo(300), finishedAt: minutesAgo(100) })] }), nowMs)).toBeNull();
  });
});

describe("stuck rule 3: blocked, with no open blocker and no pending interaction", () => {
  const base = issue({ id: "a", status: "blocked" });

  it("flags a blocked task with nothing to wait on", () => {
    expect(stuckBlockedWithoutBlocker(ctx({ issue: base }))?.reason).toBe("Blocked, but no open blocker and no pending question");
  });

  it("does not flag when a blocker or a pending question exists", () => {
    expect(stuckBlockedWithoutBlocker(ctx({ issue: base, openBlockerCount: 1 }))).toBeNull();
    expect(stuckBlockedWithoutBlocker(ctx({ issue: base, pendingQuestionCount: 1 }))).toBeNull();
    expect(stuckBlockedWithoutBlocker(ctx({ issue: { ...base, status: "in_progress" } }))).toBeNull();
  });
});

describe("stuck rule 4: a review open more than 2 h with no run", () => {
  const review = issue({ id: "a", status: "todo", createdAt: minutesAgo(150) });

  it("flags a review that never ran", () => {
    expect(stuckReviewIdle(ctx({ issue: review, isReview: true }), nowMs)?.reason).toBe("Review open 2 h 30 min and no run yet");
  });

  it("flags a review whose last run ended more than 2 h ago", () => {
    const old = issue({ id: "a", status: "in_progress", createdAt: minutesAgo(400) });
    const flag = stuckReviewIdle(ctx({ issue: old, isReview: true, runs: [run({ id: "r", issueId: "a", createdAt: minutesAgo(300), startedAt: minutesAgo(300), finishedAt: minutesAgo(130) })] }), nowMs);
    expect(flag?.reason).toBe("Review open 6 h 40 min, no run for 2 h 10 min");
  });

  it("does not flag young reviews, reviews with recent runs or non-review tasks", () => {
    expect(stuckReviewIdle(ctx({ issue: { ...review, createdAt: minutesAgo(90) }, isReview: true }), nowMs)).toBeNull();
    expect(stuckReviewIdle(ctx({ issue: review, isReview: true, runs: [run({ id: "r", issueId: "a", finishedAt: minutesAgo(20) })] }), nowMs)).toBeNull();
    expect(stuckReviewIdle(ctx({ issue: review, isReview: false }), nowMs)).toBeNull();
  });
});

describe("stuck rule 5: the same failure repeated 3 times", () => {
  const base = issue({ id: "a", status: "in_progress" });
  const failed = (id: string, errorCode: string | null, error: string | null = null) =>
    run({ id, issueId: "a", status: "failed", errorCode, error });

  it("flags three identical failures in a row", () => {
    const flag = stuckRepeatedFailure(ctx({ issue: base, runs: [failed("1", "adapter_failed"), failed("2", "adapter_failed"), failed("3", "adapter_failed")] }));
    expect(flag?.reason).toBe("Same failure 3 times in a row: adapter_failed");
  });

  it("matches on the first error line when there is no code", () => {
    const runs = [failed("1", null, "Out of memory\nstack"), failed("2", null, "Out of memory"), failed("3", null, "Out of memory\nother")];
    expect(stuckRepeatedFailure(ctx({ issue: base, runs }))?.rule).toBe("repeated_failure");
  });

  it("does not flag different failures, a success in between, or only two failures", () => {
    expect(stuckRepeatedFailure(ctx({ issue: base, runs: [failed("1", "a"), failed("2", "b"), failed("3", "a")] }))).toBeNull();
    expect(stuckRepeatedFailure(ctx({ issue: base, runs: [failed("1", "a"), run({ id: "2", issueId: "a" }), failed("3", "a")] }))).toBeNull();
    expect(stuckRepeatedFailure(ctx({ issue: base, runs: [failed("1", "a"), failed("2", "a")] }))).toBeNull();
  });
});

describe("buildStapleConsoleBoard", () => {
  it("groups a coordinator issue with its build and review children into one lane card", () => {
    const board = buildStapleConsoleBoard(boardInput({
      issues: [
        issue({ id: "root", identifier: "STA-10", title: "FAC-792 | Kaia in Ember Vault", status: "blocked", assigneeAgentId: "coord" }),
        issue({ id: "impl", identifier: "STA-11", title: "Implement Kaia", parentId: "root", status: "in_progress", assigneeAgentId: "eng", startedAt: minutesAgo(30) }),
      ],
      runs: [run({ id: "r1", issueId: "impl", status: "running", startedAt: minutesAgo(12), finishedAt: null })],
    }));
    const lane = board.lanes.find((candidate) => candidate.key === "ember_vault")!;
    expect(lane.cards).toHaveLength(1);
    const card = lane.cards[0]!;
    expect(card.betaTag).toBe("beta");
    expect(card.step).toBe("build");
    expect(card.round).toBe(1);
    expect(card.currentRunStartedAt).toBe(minutesAgo(12));
    expect(card.members.map((member) => member.role)).toEqual(["coordinator", "build"]);
    expect(card.stuck).toEqual([]);
    expect(board.header.inFlight).toBe(1);
  });

  it("returns to Build round 2 after a review sends work back", () => {
    const board = buildStapleConsoleBoard(boardInput({
      issues: [
        issue({ id: "root", identifier: "STA-10", title: "FAC-818: Backpack art", status: "blocked", assigneeAgentId: "coord" }),
        issue({ id: "impl", identifier: "STA-11", title: "Implement backpack art", parentId: "root", status: "in_progress", assigneeAgentId: "eng" }),
        issue({ id: "rev", identifier: "STA-12", title: "Independent review of PR #703", parentId: "root", status: "done", assigneeAgentId: "rev", completedAt: minutesAgo(90) }),
      ],
      runs: [run({ id: "r1", issueId: "impl", status: "running", startedAt: minutesAgo(20), finishedAt: null })],
    }));
    const card = board.lanes.flatMap((lane) => lane.cards)[0]!;
    expect(card.step).toBe("build");
    expect(card.round).toBe(2);
    expect(card.steps.find((cell) => cell.step === "build")).toEqual({ step: "build", state: "current", rounds: 2 });
    expect(card.steps.find((cell) => cell.step === "review")?.rounds).toBe(1);
  });

  it("shows waiting chips that point at the blocking card, and needs-Ethan questions with answer links", () => {
    const board = buildStapleConsoleBoard(boardInput({
      issues: [
        issue({ id: "a", identifier: "STA-20", title: "FAC-830: Item art trees", status: "blocked", assigneeAgentId: "coord" }),
        issue({ id: "b", identifier: "STA-21", title: "FAC-818: Backpack art", status: "in_progress", assigneeAgentId: "coord" }),
      ],
      relations: [{ blockerIssueId: "b", blockedIssueId: "a" }],
      interactions: [{ id: "q1", issueId: "b", kind: "ask_user_questions", status: "pending", question: "Ship the 3x art?", addresseeAgentId: null, createdAt: minutesAgo(5) }],
    }));
    const cards = board.lanes.flatMap((lane) => lane.cards);
    const blocked = cards.find((card) => card.identifier === "STA-20")!;
    expect(blocked.waitingOn).toEqual([{ issueIdentifier: "STA-21", title: "FAC-818: Backpack art", status: "in_progress", cardId: "b" }]);
    expect(blocked.stuck).toEqual([]);
    const asking = cards.find((card) => card.identifier === "STA-21")!;
    expect(asking.needsEthan).toEqual([{ issueIdentifier: "STA-21", question: "Ship the 3x art?", href: "/issues/STA-21#interaction-q1", kind: "interaction" }]);
    expect(board.header.needsEthan).toBe(1);
    expect(cards[0]!.identifier).toBe("STA-21");
  });

  it("counts merged-today work and lists FAC-50 items without a task as up next", () => {
    const board = buildStapleConsoleBoard(boardInput({
      issues: [
        issue({ id: "m", identifier: "STA-30", title: "FAC-832: Self-serve accounts", status: "done", completedAt: minutesAgo(60), assigneeAgentId: "coord" }),
        issue({ id: "old", identifier: "STA-31", title: "FAC-626 | Account bridge", status: "done", completedAt: minutesAgo(60 * 30), assigneeAgentId: "coord" }),
      ],
    }));
    const cards = board.lanes.flatMap((lane) => lane.cards);
    expect(cards.map((card) => card.identifier)).toEqual(["STA-30"]);
    expect(cards[0]!.step).toBe("merged");
    expect(board.header.mergedToday).toBe(1);
    const facs = board.upNext.map((item) => item.fac);
    expect(facs).not.toContain(832);
    expect(facs).not.toContain(626);
    expect(board.upNext.find((item) => item.fac === 752)).toMatchObject({ betaGap: true, lane: "launcher" });
    expect(board.upNext[0]!.betaGap).toBe(true);
  });

  it("puts internal tasks without a FAC id in the Staple lane and attaches 'STA-N |' orphans to STA-N", () => {
    const board = buildStapleConsoleBoard(boardInput({
      issues: [
        issue({ id: "root", identifier: "STA-40", title: "Fork CI: run only touched jobs", status: "in_progress", assigneeAgentId: "coord" }),
        issue({ id: "orphan", identifier: "STA-41", title: "STA-40 | Implement path-scoped CI", status: "in_progress", assigneeAgentId: "eng" }),
      ],
      runs: [run({ id: "r", issueId: "orphan", status: "running", startedAt: minutesAgo(5), finishedAt: null })],
    }));
    const lane = board.lanes.find((candidate) => candidate.key === "staple")!;
    expect(lane.cards).toHaveLength(1);
    expect(lane.cards[0]!.members.map((member) => member.identifier)).toEqual(["STA-40", "STA-41"]);
  });

  it("moves to CI while a GitHub Actions monitor waits and no build run is active", () => {
    const board = buildStapleConsoleBoard(boardInput({
      issues: [
        issue({ id: "root", identifier: "STA-50", title: "FAC-829: Content packs", status: "blocked", assigneeAgentId: "coord" }),
        issue({ id: "impl", identifier: "STA-51", title: "Content pack verifier", parentId: "root", status: "in_progress", assigneeAgentId: "eng", monitorServiceName: "github-actions", monitorTriggeredAt: minutesAgo(15), monitorNextCheckAt: minutesAgo(-10) }),
      ],
    }));
    const card = board.lanes.find((lane) => lane.key === "updates")!.cards[0]!;
    expect(card.step).toBe("ci");
    expect(card.stepSince).toBe(minutesAgo(15));
  });
});

describe("extractFacIds", () => {
  it("reads single and slash-joined ids", () => {
    expect(extractFacIds("FAC-798/799 | Integrate catalog")).toEqual([798, 799]);
    expect(extractFacIds("No id")).toEqual([]);
  });
});

describe("stapleConsoleFreshness", () => {
  it("reports seconds while fresh and greys out after 2 minutes", () => {
    expect(stapleConsoleFreshness(nowMs - 12_000, nowMs)).toEqual({ ageMs: 12_000, stale: false, label: "Updated 12 s ago" });
    expect(stapleConsoleFreshness(nowMs - 120_000, nowMs).stale).toBe(false);
    expect(stapleConsoleFreshness(nowMs - 121_000, nowMs)).toEqual({ ageMs: 121_000, stale: true, label: "Updated 2 min ago" });
    expect(stapleConsoleFreshness(null, nowMs)).toEqual({ ageMs: null, stale: true, label: "Not loaded yet" });
  });
});

describe("source helpers", () => {
  it("finds the next 03:30 in Denver across a day boundary", () => {
    expect(nextStapleConsoleLocalTime("2026-11-09T15:00:00.000Z", "03:30")).toBe("2026-11-10T10:30:00.000Z");
    expect(nextStapleConsoleLocalTime("2026-11-09T09:00:00.000Z", "03:30")).toBe("2026-11-09T10:30:00.000Z");
    // Summer time (UTC-6)
    expect(nextStapleConsoleLocalTime("2026-07-01T12:00:00.000Z", "03:20")).toBe("2026-07-02T09:20:00.000Z");
  });

  it("resolves bare PR numbers to the lane repository and keeps full URLs", () => {
    expect(stapleConsoleDefaultRepo(["FAC-818: Backpack art"])).toBe("ethanmonlux/facette");
    expect(stapleConsoleDefaultRepo(["FAC-620: Staple Console"])).toBe("ethanmonlux/paperclip");
    expect(stapleConsoleDefaultRepo(["Fork CI"])).toBe("ethanmonlux/paperclip");
    expect(extractStapleConsolePrRefs(
      "Review FAC-829 slice 1 PR #704 @ 1256",
      "See https://github.com/ethanmonlux/workflow-console/pull/12 and PR #9",
      "ethanmonlux/facette",
    )).toEqual([
      { repo: "ethanmonlux/workflow-console", number: 12, url: "https://github.com/ethanmonlux/workflow-console/pull/12" },
      { repo: "ethanmonlux/facette", number: 704, url: "https://github.com/ethanmonlux/facette/pull/704" },
    ]);
  });
});
