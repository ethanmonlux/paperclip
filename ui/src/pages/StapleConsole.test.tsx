// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildStapleConsoleBoard,
  type StapleConsoleInput,
  type StapleConsoleIssueInput,
} from "@paperclipai/shared/staple-console";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>{children}</a>
  ),
}));

const { StapleConsoleBoardView } = await import("./StapleConsole");

const NOW = "2026-11-09T15:00:00.000Z";
const nowMs = Date.parse(NOW);
const minutesAgo = (minutes: number) => new Date(nowMs - minutes * 60_000).toISOString();

function issue(overrides: Partial<StapleConsoleIssueInput> & { id: string }): StapleConsoleIssueInput {
  return {
    identifier: overrides.id.toUpperCase(), title: `Task ${overrides.id}`, status: "todo", parentId: null,
    assigneeAgentId: "eng", assigneeUserId: null, createdAt: minutesAgo(600), startedAt: null, completedAt: null,
    updatedAt: minutesAgo(600), monitorNextCheckAt: null, ...overrides,
  };
}

function board(overrides: Partial<StapleConsoleInput> = {}) {
  return buildStapleConsoleBoard({
    now: NOW, issuePrefix: "STA", agents: [{ id: "eng", name: "Portfolio Engineer", role: "engineer" }],
    issues: [], relations: [], runs: [], wakes: [], interactions: [], approvals: [], pullRequests: [], scheduled: [],
    sources: { github: { available: true, detail: "test" } }, ...overrides,
  });
}

const capabilityMap = {
  issueIdentifier: "STA-152", revisionNumber: 1, updatedAt: minutesAgo(5),
  body: JSON.stringify({
    groups: [{
      key: "staple", label: "Staple, building itself", capabilities: [{
        key: "cycling", title: "Keeps cycling", claims: [
          { text: "Tasks wake when their blocker lands", why: "Blocked tasks sat idle.", issues: ["STA-2"], override: { state: "green", reason: "Seen it" } },
          { text: "Engineers can merge their own reviewed work", why: "Merges waited on a person.", issues: ["STA-3"] },
        ],
      }],
    }],
  }),
};

describe("Staple Console progressive depth", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
  });

  const render = async (value: ReturnType<typeof board>) => {
    await act(() => root.render(<StapleConsoleBoardView board={value} now={nowMs} />));
  };
  const q = (selector: string) => [...container.querySelectorAll<HTMLElement>(selector)];
  const click = async (element: HTMLElement) => { await act(async () => { element.click(); }); };

  it("shows one green line when nothing needs Ethan and nothing is stalled", async () => {
    await render(board({ issues: [issue({ id: "a", identifier: "STA-1", title: "FAC-818: Backpack art" })] }));
    expect(container.querySelector("[data-testid=staple-console-all-clear]")?.textContent).toContain("Nothing needs you; nothing stalled.");
    expect(container.querySelector("[data-testid=staple-console-attention]")).toBeNull();
    expect(q("[data-testid=staple-console-tiles] > div").map((tile) => tile.textContent))
      .toEqual(["0Merged today", "0In flight", "0Needs you", "0Stuck"]);
  });

  it("pins founder questions before stuck work in Needs attention", async () => {
    await render(board({
      issues: [
        issue({ id: "s", identifier: "STA-10", title: "FAC-818: Backpack art", status: "in_progress", startedAt: minutesAgo(120) }),
        issue({ id: "q", identifier: "STA-11", title: "FAC-830: Item art trees", status: "in_progress" }),
      ],
      runs: [{ id: "r", issueId: "q", agentId: "eng", status: "running", createdAt: minutesAgo(5), startedAt: minutesAgo(5), finishedAt: null, lastOutputAt: minutesAgo(1), errorCode: null, error: null }],
      interactions: [{ id: "i1", issueId: "q", kind: "ask_user_questions", status: "pending", question: "Ship the 3x art?", addresseeAgentId: null, createdAt: minutesAgo(5) }],
    }));
    const items = q("[data-testid=staple-console-attention] li");
    expect(items.map((item) => item.dataset.kind)).toEqual(["needs_you", "stuck"]);
    expect(items[0]!.textContent).toContain("Ship the 3x art?");
    expect(items[0]!.querySelector("a")?.textContent).toBe("Answer");
    expect(container.querySelector("[data-testid=staple-console-all-clear]")).toBeNull();
  });

  it("hides empty lanes as one muted line and keeps cards collapsed until tapped", async () => {
    await render(board({
      issues: [
        issue({ id: "root", identifier: "STA-20", title: "FAC-829: Content packs", status: "in_progress" }),
        issue({ id: "c1", identifier: "STA-21", title: "Build content packs", status: "in_progress", parentId: "root" }),
        issue({ id: "c2", identifier: "STA-22", title: "Pack docs", status: "todo", parentId: "root" }),
      ],
      comments: [{ issueId: "c1", authorAgentId: "eng", authorUserId: null, body: "Pushed the pack loader.", createdAt: minutesAgo(3) }],
    }));
    const empty = q("[data-testid=staple-console-lane-empty]").map((line) => line.textContent);
    expect(empty).toContain("Launcher · nothing active");
    expect(q("[data-testid=staple-console-lane]").map((lane) => lane.dataset.lane)).toEqual(["updates"]);

    const card = container.querySelector<HTMLElement>("[data-testid=staple-console-card]")!;
    expect(card.dataset.expanded).toBe("false");
    expect(card.querySelector("h3")?.textContent).toBe("Content packs");
    expect(card.querySelector("[data-testid=staple-console-caption]")?.textContent).toBe("Build · Portfolio Engineer");
    expect(card.textContent).not.toContain("STA-21");
    expect(card.querySelector("[data-testid=staple-console-card-detail]")).toBeNull();

    await click(card.querySelector<HTMLElement>("button[aria-expanded]")!);
    expect(card.dataset.expanded).toBe("true");
    const detail = card.querySelector("[data-testid=staple-console-card-detail]")!;
    expect(detail.textContent).toContain("STA-21");
    expect(detail.textContent).toContain("Pushed the pack loader.");

    await click(card.querySelector<HTMLElement>("button[aria-expanded]")!);
    expect(card.querySelector("[data-testid=staple-console-card-detail]")).toBeNull();
  });

  it("shows the legend, collapsed capability counts, and a green claim without proof as blue", async () => {
    await render(board({
      issues: [
        issue({ id: "a", identifier: "STA-2", title: "Wake on blocker", status: "done", completedAt: minutesAgo(600 * 3) }),
        issue({ id: "b", identifier: "STA-3", title: "Self merge", status: "todo", assigneeAgentId: null }),
      ],
      capabilityMap,
    }));
    expect(container.querySelector("[data-testid=staple-console-legend]")?.textContent).toContain("Works now, with proof");
    expect(q("[data-testid=staple-console-claim]")).toHaveLength(0);

    const capability = container.querySelector<HTMLElement>("[data-testid=staple-console-capability]")!;
    expect(capability.textContent).toContain("Keeps cycling");
    await click(capability.querySelector<HTMLElement>("button[aria-expanded]")!);
    const claims = q("[data-testid=staple-console-claim]");
    expect(claims.map((row) => row.dataset.state)).toEqual(["blue", "red"]);
    expect(claims[0]!.textContent).toContain("Why: Blocked tasks sat idle.");

    await click(claims[0]!.querySelector<HTMLElement>("button[aria-expanded]")!);
    expect(claims[0]!.textContent).toContain("no merged PR proves it");
    expect(claims[0]!.querySelector("[data-testid=staple-console-proof]")?.textContent).toContain("No PR linked");
  });

  it("collapses Up next behind its count", async () => {
    const value = board();
    await render(value);
    const toggle = container.querySelector<HTMLElement>("[data-testid=staple-console-upnext-toggle]")!;
    expect(toggle.textContent).toContain(`· ${value.upNext.length}`);
    expect(container.querySelector("[data-testid=staple-console-upnext]")).toBeNull();
    await click(toggle);
    expect(q("[data-testid=staple-console-upnext] li")).toHaveLength(value.upNext.length);
  });
});
