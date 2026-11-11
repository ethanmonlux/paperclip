// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoordinatorSidebar } from "./CoordinatorSidebar";
import { MobileBottomNav } from "./MobileBottomNav";
import { TooltipProvider } from "./ui/tooltip";

// STA-213: the Staple Console has a first-class nav entry under Inbox (above
// More) and leads the phone bottom bar, using the real company-prefixed router.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@/hooks/useAgentChatNavigation", () => ({ useAgentChatNavigation: () => ({
  companyId: "company", userId: "founder", agents: { data: [] }, chats: { data: [] }, session: { isSuccess: true },
}) }));
vi.mock("@/hooks/useRecentTasks", () => ({ useRecentTasks: () => ({ entries: [] }) }));
vi.mock("@/hooks/useCoordinatorAttentionCount", () => ({ useCoordinatorAttentionCount: () => 0 }));
vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({ useCoordinatorWorkspaceEnabled: () => ({ enabled: true }) }));
vi.mock("@/hooks/useAgentChatEnabled", () => ({ useAgentChatEnabled: () => ({ enabled: true }) }));
vi.mock("@/hooks/useCombinedInboxTasksEnabled", () => ({ useCombinedInboxTasksEnabled: () => ({ enabled: false }) }));
vi.mock("@/hooks/useInboxBadge", () => ({ useInboxBadge: () => ({ inbox: 0, failedRuns: 0 }) }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company", selectedCompany: { issuePrefix: "STA" } }) }));
vi.mock("@/context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: vi.fn() }) }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ collapsed: false, peeking: false, isMobile: true, setSidebarOpen: vi.fn() }) }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: async () => ({}) } }));
vi.mock("@/api/projects", () => ({ projectsApi: { list: async () => [] } }));
vi.mock("./SidebarCompanyMenu", () => ({ SidebarCompanyMenu: () => null }));

let root: Root, container: HTMLDivElement, client: QueryClient;
function ReturnStateProbe() {
  const location = useLocation();
  return <output data-testid="return-state">{(location.state as { itemArtworkReturnTo?: string } | null)?.itemArtworkReturnTo ?? ""}</output>;
}
beforeEach(() => {
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); client.clear(); });

async function render(pathname: string) {
  await act(async () => root.render(<QueryClientProvider client={client}><TooltipProvider>
    <MemoryRouter initialEntries={[pathname]}><Routes><Route path="/:companyPrefix/*" element={<>
      <CoordinatorSidebar /><MobileBottomNav visible /><ReturnStateProbe />
    </>} /></Routes></MemoryRouter>
  </TooltipProvider></QueryClientProvider>));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}
const sidebar = () => container.querySelector('nav[aria-label="Workspace navigation"]')!;
const bottomBar = () => container.querySelector('nav[aria-label="Mobile navigation"]')!;
const consoleLink = (scope: Element) => scope.querySelector<HTMLAnchorElement>('a[href="/STA/console"]');

describe("Console navigation", () => {
  it("sits directly under Inbox and above More without opening More", async () => {
    await render("/STA/issues");
    const primary = [...sidebar().querySelectorAll<HTMLElement>(".design-sidebar-primary a, .design-sidebar-primary > button[aria-label='More workspace pages']")];
    const labels = primary.map(item => item.textContent?.trim());
    expect(labels).toEqual(["Chat", "Tasks", "Inbox", "Console", "Item artwork", "More"]);
    expect(consoleLink(sidebar())?.getAttribute("aria-current")).toBeNull();
  });
  it("highlights the sidebar item on /STA/console", async () => {
    await render("/STA/console");
    const link = consoleLink(sidebar())!;
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(link.className).toContain("bg-sidebar-accent");
    expect(sidebar().querySelector('a[href="/STA/decisions"]')?.getAttribute("aria-current")).toBeNull();
  });
  it("leads the phone bottom bar and marks it active on /STA/console", async () => {
    await render("/STA/console");
    const items = [...bottomBar().querySelectorAll("a, button")];
    expect(items.map(item => item.textContent)).toEqual(["Console", "Chat", "Tasks", "Inbox", "New task", "Item artwork"]);
    expect(consoleLink(bottomBar())?.getAttribute("aria-current")).toBe("page");
  });
  it("leaves the bottom-bar item inactive elsewhere", async () => {
    await render("/STA/issues");
    expect(consoleLink(bottomBar())?.getAttribute("aria-current")).toBeNull();
  });
  it("keeps Item artwork directly available in desktop and phone navigation", async () => {
    await render("/STA/item-artwork");
    for (const navigation of [sidebar(), bottomBar()]) {
      const link = navigation.querySelector<HTMLAnchorElement>('a[href="/STA/item-artwork"]');
      expect(link?.textContent).toContain("Item artwork");
      expect(link?.getAttribute("aria-current")).toBe("page");
    }
  });
  it("records the current company view when opening Item artwork in-app", async () => {
    await render("/STA/issues?q=items&status=open");
    await act(async () => {
      bottomBar().querySelector<HTMLAnchorElement>('a[href="/STA/item-artwork"]')!.click();
    });
    expect(container.querySelector('[data-testid="return-state"]')?.textContent).toBe("/STA/issues?q=items&status=open");
  });
});
