// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildStapleConsoleBoard,
  buildStapleConsoleUpgradeStatus,
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

  it("lists stuck work before founder questions in Needs attention, with a summary of every category", async () => {
    await render(board({
      issues: [
        issue({ id: "s", identifier: "STA-10", title: "FAC-818: Backpack art", status: "in_progress", startedAt: minutesAgo(120) }),
        issue({ id: "q", identifier: "STA-11", title: "FAC-830: Item art trees", status: "in_progress" }),
      ],
      runs: [{ id: "r", issueId: "q", agentId: "eng", status: "running", createdAt: minutesAgo(5), startedAt: minutesAgo(5), finishedAt: null, lastOutputAt: minutesAgo(1), errorCode: null, error: null }],
      interactions: [{ id: "i1", issueId: "q", kind: "ask_user_questions", status: "pending", question: "Ship the 3x art?", addresseeAgentId: null, createdAt: minutesAgo(5) }],
    }));
    const items = q("[data-testid=staple-console-attention-item]");
    expect(items.map((item) => item.dataset.kind)).toEqual(["stuck", "needs_you"]);
    expect(items[1]!.textContent).toContain("Ship the 3x art?");
    expect(items[1]!.querySelector("a")?.textContent).toBe("Answer");
    expect(container.querySelector("[data-testid=staple-console-attention-summary-line]")?.textContent).toBe("· 1 stuck · 1 question for you");
    expect(container.querySelector("[data-testid=staple-console-all-clear]")).toBeNull();
  });

  // FAC-927: Level 1 stays one screen. Questions are one plain line with the full text a tap away,
  // only five show before "more", and merges nobody owns fold into one counted row.
  it("keeps Level 1 to one plain line per question, folds extra questions and unowned merges, and drops nothing", async () => {
    const long = "**What:** live re-check of founder alerts. Last time the DM had no tappable link; `92585ac2` has the fix.";
    const asks = Array.from({ length: 7 }, (_, index) => issue({ id: `q${index}`, identifier: `STA-${50 + index}`, title: `FAC-830: Ask ${index}`, status: "in_progress" }));
    const done = Array.from({ length: 3 }, (_, index) => issue({ id: `d${index}`, identifier: `STA-${70 + index}`, title: `FAC-829: Done ${index}`, status: "done", completedAt: minutesAgo(30) }));
    await render(board({
      issues: [...asks, ...done],
      runs: asks.map((ask) => ({ id: `r-${ask.id}`, issueId: ask.id, agentId: "eng", status: "running", createdAt: minutesAgo(5), startedAt: minutesAgo(5), finishedAt: null, lastOutputAt: minutesAgo(1), errorCode: null, error: null })),
      interactions: asks.map((ask, index) => ({ id: `i${index}`, issueId: ask.id, kind: "ask_user_questions", status: "pending", question: index === 0 ? long : `Ship art ${index}?`, addresseeAgentId: null, createdAt: minutesAgo(5) })),
      pullRequests: done.map((task, index) => ({
        issueId: task.id, repo: "ethanmonlux/facette", number: 800 + index, url: `https://github.com/ethanmonlux/facette/pull/${800 + index}`,
        state: "open", mergedAt: null, ci: "unknown", ciStartedAt: null, source: "work_product",
      })),
    }));
    expect(container.querySelector("[data-testid=staple-console-attention-summary-line]")?.textContent).toBe("· 7 questions for you · 3 merges nobody owns");
    expect(q("[data-testid=staple-console-attention-item]")).toHaveLength(5);
    const first = q("[data-testid=staple-console-attention-item]")[0]!;
    expect(first.querySelector("[data-testid=staple-console-attention-summary]")?.textContent).toBe("What: live re-check of founder alerts.");
    expect(first.textContent).not.toContain("**");
    await click(first.querySelector<HTMLElement>("[data-testid=staple-console-attention-more]")!);
    expect(first.textContent).toContain("92585ac2 has the fix.");
    expect(first.textContent).not.toContain("`");

    await click(container.querySelector<HTMLElement>("[data-testid=staple-console-attention-more-questions]")!);
    expect(q("[data-testid=staple-console-attention-item]")).toHaveLength(7);

    const merges = container.querySelector<HTMLElement>("[data-testid=staple-console-attention-merges]")!;
    expect(merges.textContent).toContain("3 done, merge not confirmed");
    expect(merges.querySelectorAll("li")).toHaveLength(0);
    await click(merges.querySelector<HTMLElement>("button[aria-expanded]")!);
    expect(merges.querySelectorAll("li")).toHaveLength(3);
    expect(merges.textContent).toContain("recorded open, merge not confirmed");
  });

  // FAC-928: a tile counts exactly the rows listed under it.
  it("counts two questions on one card as two in Needs you, matching the rows", async () => {
    await render(board({
      issues: [issue({ id: "q", identifier: "STA-11", title: "FAC-830: Item art trees", status: "in_progress" })],
      runs: [{ id: "r", issueId: "q", agentId: "eng", status: "running", createdAt: minutesAgo(5), startedAt: minutesAgo(5), finishedAt: null, lastOutputAt: minutesAgo(1), errorCode: null, error: null }],
      interactions: ["Ship the 3x art?", "Keep the old frames?"].map((question, index) => ({
        id: `i${index}`, issueId: "q", kind: "ask_user_questions", status: "pending", question, addresseeAgentId: null, createdAt: minutesAgo(5),
      })),
    }));
    const tiles = q("[data-testid=staple-console-tiles] > div").map((tile) => tile.textContent);
    expect(tiles).toContain("2Needs you");
    expect(q("[data-testid=staple-console-attention-item][data-kind=needs_you]")).toHaveLength(2);
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

  it("lets a shipped card outside the capability map expand its proof, listed once with its anchor", async () => {
    await render(board({
      issues: [issue({ id: "m", identifier: "STA-30", title: "FAC-832: Self-serve accounts", status: "done", completedAt: minutesAgo(60) })],
      pullRequests: [{
        issueId: "m", repo: "ethanmonlux/facette", number: 900, url: "https://github.com/ethanmonlux/facette/pull/900",
        state: "merged", mergedAt: minutesAgo(70), ci: "success", ciStartedAt: null, source: "github",
      }],
      capabilityMap,
    }));
    const rows = q("[data-testid=staple-console-shipped-row]");
    expect(rows).toHaveLength(1);
    expect(q("[data-testid=staple-console-card]")).toHaveLength(0);
    expect(rows[0]!.id).toBe("console-card-m");
    expect(rows[0]!.querySelector("[data-testid=staple-console-card-detail]")).toBeNull();
    await click(rows[0]!.querySelector<HTMLElement>("button[aria-expanded]")!);
    const detail = rows[0]!.querySelector("[data-testid=staple-console-card-detail]");
    expect(detail?.textContent).toContain("PR and CI");
    expect(detail?.textContent).toContain("STA-30");
  });

  it("says how Finished today differs from Merged today", async () => {
    await render(board({
      issues: [
        issue({ id: "m", identifier: "STA-30", title: "FAC-832: Self-serve accounts", status: "done", completedAt: minutesAgo(60) }),
        issue({ id: "e", identifier: "STA-31", title: "FAC-829: Content packs", status: "done", completedAt: minutesAgo(60) }),
        issue({ id: "n", identifier: "STA-32", title: "FAC-818: Backpack art", status: "done", completedAt: minutesAgo(60) }),
      ],
      pullRequests: [
        { issueId: "m", repo: "ethanmonlux/facette", number: 900, url: "https://github.com/ethanmonlux/facette/pull/900", state: "merged", mergedAt: minutesAgo(70), ci: "success", ciStartedAt: null, source: "github" },
        { issueId: "e", repo: "ethanmonlux/facette", number: 901, url: "https://github.com/ethanmonlux/facette/pull/901", state: "merged", mergedAt: minutesAgo(60 * 48), ci: "success", ciStartedAt: null, source: "github" },
      ],
    }));
    expect(q("[data-testid=staple-console-tiles] > div")[0]!.textContent).toBe("1Merged today");
    expect(container.querySelector("[data-testid=staple-console-shipped] h2")?.textContent).toBe("Finished today · 3");
    expect(container.querySelector("[data-testid=staple-console-finished-breakdown]")?.textContent)
      .toBe("1 merged today · 1 merged before today · 1 finished without a merge");
  });

  // FAC-929: the workstream's step is not a PR's; a PR state not read live says so; and the
  // installed build is Staple's, so a Facette claim does not borrow it.
  it("separates workstream and PR state, labels recorded PR state, and scopes the installed build to Staple", async () => {
    const map = {
      issueIdentifier: "STA-152", revisionNumber: 1, updatedAt: minutesAgo(5),
      body: JSON.stringify({
        groups: [
          { key: "staple", label: "Staple, building itself", capabilities: [{ key: "merge", title: "Merges", claims: [{ text: "Merges land", why: "W.", issues: ["STA-60"] }] }] },
          { key: "facette", label: "Facette", capabilities: [{ key: "face", title: "Face", claims: [{ text: "Kaia idles", why: "W.", issues: ["STA-61"] }] }] },
        ],
      }),
    };
    await render(board({
      issues: [
        issue({ id: "w", identifier: "STA-60", title: "FAC-829: Content packs", status: "in_progress" }),
        issue({ id: "w2", identifier: "STA-62", title: "Pack docs", status: "todo", parentId: "w" }),
        issue({ id: "f", identifier: "STA-61", title: "FAC-818: Kaia idle", status: "done", completedAt: minutesAgo(60 * 48) }),
      ],
      pullRequests: [
        { issueId: "w", repo: "ethanmonlux/paperclip", number: 64, url: "https://github.com/ethanmonlux/paperclip/pull/64", state: "open", mergedAt: null, ci: "unknown", ciStartedAt: null, source: "work_product" },
        { issueId: "f", repo: "ethanmonlux/facette", number: 720, url: "https://github.com/ethanmonlux/facette/pull/720", state: "merged", mergedAt: minutesAgo(60 * 49), ci: "success", ciStartedAt: null, source: "github" },
      ],
      capabilityMap: map,
      installedBuild: "92585ac",
    }));
    const card = container.querySelector<HTMLElement>("[data-testid=staple-console-card]")!;
    await click(card.querySelector<HTMLElement>("button[aria-expanded]")!);
    expect(card.querySelector("[data-testid=staple-console-workstream-state]")?.textContent).toBe("Workstream at Build · 2 of 2 tasks open");
    expect(card.textContent).toContain("paperclip#64 last recorded open · not checked live");

    for (const capability of q("[data-testid=staple-console-capability]")) await click(capability.querySelector<HTMLElement>("button[aria-expanded]")!);
    for (const claim of q("[data-testid=staple-console-claim]")) await click(claim.querySelector<HTMLElement>("button[aria-expanded]")!);
    const proofs = q("[data-testid=staple-console-proof]").map((proof) => proof.textContent ?? "");
    expect(proofs[0]).toContain("Installed Staple build: 92585ac");
    expect(proofs[1]).not.toContain("92585ac");
    expect(proofs[1]).toContain("Deployed build: not tracked here");
  });

  // FAC-930: a planned job Paperclip does not record is never shown as a definite time.
  it("shows planned schedule entries as unverified with their source, apart from recorded monitors", async () => {
    await render(board({
      scheduled: [
        { label: "2:30 maintenance hold", at: "2026-11-10T09:30:00.000Z", detail: null, source: "Founder schedule in FAC-620; this job is not recorded in Paperclip", available: false },
        { label: "STA-5 monitor check", at: minutesAgo(-10), detail: "Last log entry " + minutesAgo(30), source: "Paperclip issue monitor", available: true },
      ],
    }));
    const planned = container.querySelector("[data-testid=staple-console-schedule-planned]")!;
    expect(planned.textContent).toContain("Planned, not verified here");
    expect(planned.textContent).toMatch(/Planned .* · not verified/);
    expect(planned.textContent).toContain("Source: Founder schedule in FAC-620");
    const recorded = container.querySelector("[data-testid=staple-console-schedule-recorded]")!;
    expect(recorded.textContent).toContain("STA-5 monitor check");
    expect(recorded.textContent).toContain("Last log entry 30 min ago");
    expect(recorded.textContent).not.toContain("not verified");
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

describe("Staple Console upgrade card", () => {
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

  // Installer lines in UTC to keep the fixtures readable; NOW is 15:00Z.
  const line = (minutes: number, text: string) => `[${minutesAgo(minutes).slice(0, 19).replace("T", " ")}] ${text}`;
  const installingLog = [
    line(14, "== Staple nightly upgrade (dry=0 quiet=0)"),
    line(14, "installed=69187fe6aaaa master=92585ac2bbbb"),
    line(14, "certified target: target:92585ac2bbbb installed-in-chain:yes"),
    line(13, "running or settling work: 0 (queued work is held)"),
    line(12, "backup: file:/x.sql.gz"),
    line(11, "installing 92585ac2"),
  ];
  const hold = { since: minutesAgo(14), drainDeadlineAt: minutesAgo(-31), expiresAt: minutesAgo(-76), queuedWakes: 4, runningRuns: 0, parkedRuns: 0 };
  const upgradeBoard = (lines: string[], overrides: { hold?: typeof hold | null; serverStartedAt?: string; modifiedMinutesAgo?: number } = {}) => ({
    ...board(),
    upgrade: buildStapleConsoleUpgradeStatus({
      now: NOW, timeZone: "UTC", hold: overrides.hold ?? null, installedBuild: "69187fe6",
      serverStartedAt: overrides.serverStartedAt ?? minutesAgo(600), nextNightlyAt: minutesAgo(-1110),
      logs: [{ name: "upgrade-20261109-0746.log", text: `${lines.join("\n")}\n`, modifiedAt: minutesAgo(overrides.modifiedMinutesAgo ?? 0.5) }],
    }),
  });
  const render = async (value: ReturnType<typeof upgradeBoard>, connection?: { lost: boolean; lastLoadedAt: number | null }) => {
    await act(() => root.render(<StapleConsoleBoardView board={value} now={nowMs} connection={connection} />));
  };
  const get = (testId: string) => container.querySelector<HTMLElement>(`[data-testid=${testId}]`);

  it("shows a running download with stage time, freshness, hold and no invented size", async () => {
    await render(upgradeBoard(installingLog, { hold }));
    const card = get("staple-console-upgrade")!;
    expect(card.dataset.phase).toBe("running");
    expect(get("staple-console-upgrade-headline")?.textContent).toBe("Upgrading to 92585ac2 · Download + build");
    expect([...card.querySelectorAll("ol li")].map((cell) => `${cell.textContent}:${(cell as HTMLElement).dataset.state}`))
      .toEqual(["Certify:done", "Drain:done", "Backup:done", "Build:current", "Restart:pending", "Verify:pending"]);
    const facts = get("staple-console-upgrade-facts")!.textContent!;
    expect(facts).toContain("Download + build · 11 min");
    expect(facts).toContain("Elapsed14 min");
    expect(get("staple-console-upgrade-download")?.textContent).toBe("size unknown · no ETA");
    expect(facts).not.toMatch(/%|ETA \d/);
    expect(get("staple-console-upgrade-hold")?.textContent).toContain("4 queued");
    expect(get("staple-console-upgrade-next")?.textContent).toBe("Restarts Staple when the build finishes");
    expect(get("staple-console-maintenance-hold")).toBeNull();
  });

  it("keeps the last known stage through the restart disconnection", async () => {
    await render(
      upgradeBoard([...installingLog, "Installed paperclipai git payload 92585ac2bbbb."]),
      { lost: true, lastLoadedAt: nowMs - 60_000 },
    );
    expect(get("staple-console-upgrade")?.dataset.phase).toBe("running");
    expect(get("staple-console-upgrade-headline")?.textContent).toBe("Upgrading to 92585ac2 · Restart");
    expect(get("staple-console-upgrade-lost")?.textContent).toMatch(/Can't reach Staple since .*Expected while it restarts/);
  });

  it("shows a stale attempt and a rollback distinctly, and asks Ethan only when both failed", async () => {
    await render(upgradeBoard(installingLog, { modifiedMinutesAgo: 25 }));
    expect(get("staple-console-upgrade")?.dataset.phase).toBe("stale");
    expect(get("staple-console-upgrade-headline")?.textContent).toBe("Upgrade to 92585ac2 not reporting");

    await render(upgradeBoard([...installingLog,
      line(5, "verify: health commit unreadable, startup not-checked"),
      line(5, "upgrade failed verification; rolling back"),
      line(3, "REPORT: Rolled back: 92585ac2 failed checks, back on 69187fe6"),
    ]));
    expect(get("staple-console-upgrade")?.dataset.phase).toBe("rolled_back");
    expect(get("staple-console-upgrade-needs-ethan")).toBeNull();

    await render(upgradeBoard([...installingLog,
      line(5, "upgrade failed verification; rolling back"),
      line(1, "REPORT: NEEDS ETHAN: upgrade and rollback both failed"),
    ]));
    expect(get("staple-console-upgrade")?.dataset.phase).toBe("needs_ethan");
    expect(get("staple-console-upgrade-needs-ethan")?.textContent).toMatch(/^Needs you: /);
    expect(get("staple-console-upgrade-next")).toBeNull();
  });

  it("collapses an idle check to one line that expands to versions", async () => {
    await render(upgradeBoard([
      line(30, "== Staple nightly upgrade (dry=0 quiet=1)"),
      line(30, "installed=92585ac2bbbb master=92585ac2bbbb"),
      line(30, "Already on master. Nothing to do."),
    ]));
    const card = get("staple-console-upgrade")!;
    expect(card.dataset.compact).toBe("true");
    expect(card.textContent).toBe("UpgradesUp to date · on 69187fe6");
    await act(async () => { get("staple-console-upgrade-toggle")!.click(); });
    expect(get("staple-console-upgrade")?.dataset.compact).toBe("false");
    expect(get("staple-console-upgrade-detail")?.textContent).toContain("Master92585ac2");
  });
});
