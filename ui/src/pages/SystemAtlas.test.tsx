// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { atlasAffectedNodes, atlasChapters, atlasWalkthroughs } from "./system-atlas-data";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-a", companies: [{ id: "company-a" }] }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: async () => [{ id: "agent-a" }] } }));
vi.mock("@/api/staple-console", () => ({ stapleConsoleApi: {
  board: async () => ({ generatedAt: "2026-11-11T03:00:00Z", lanes: [], maintenanceHold: null }),
  source: async () => ({ authoredRevision: "a".repeat(40), installedRevision: "a".repeat(40), sourceRevision: "b".repeat(40), changedPaths: ["server/src/services/native-runtime/example.ts"], status: "changed", observedAt: "2026-11-11T03:00:00Z" }),
} }));
const { SystemAtlas } = await import("./SystemAtlas");
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 380 });
  container = document.createElement("div"); document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); client.clear(); });

describe("System Atlas", () => {
  it("keeps seven chapters, 45 linked nodes and 11 walkthroughs", () => {
    expect(atlasChapters).toHaveLength(7);
    expect(atlasChapters.flatMap((chapter) => chapter.nodes)).toHaveLength(45);
    expect(atlasWalkthroughs).toHaveLength(11);
    const ids = new Set(atlasChapters.flatMap((chapter) => chapter.nodes.map((node) => node.id)));
    for (const [, ...path] of atlasWalkthroughs) for (const id of path) expect(ids.has(id)).toBe(true);
  });
  it("marks only nodes whose source paths changed", () => {
    expect(atlasAffectedNodes(["server/src/services/native-runtime/example.ts"])).toContain("session");
    expect(atlasAffectedNodes(["server/src/services/native-runtime/example.ts"])).not.toContain("github");
  });
  it("navigates chapters and progressive detail at 380px with separate revision labels", async () => {
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/STA/system-atlas"]}><SystemAtlas /></MemoryRouter></QueryClientProvider>));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.textContent).toContain("Source revision");
    expect(container.textContent).toContain("Installed revision");
    const chapters = container.querySelector('nav[aria-label="Atlas chapters"]')!;
    expect(chapters.querySelectorAll("button")).toHaveLength(7);
    const work = [...chapters.querySelectorAll("button")].find((button) => button.textContent?.includes("Work execution"))!;
    await act(async () => work.click());
    expect(container.textContent).toContain("How approved work");
    const brief = [...container.querySelectorAll("article button")].find((button) => button.textContent?.includes("Useful brief"))!;
    await act(async () => brief.click());
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(3);
    await act(async () => (container.querySelector('[role="tab"]:nth-child(3)') as HTMLButtonElement).click());
    expect(container.textContent).toContain("Source paths:");
  });
});
