import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const activeRuns = vi.hoisted(() => ({ count: 0 }));
const manager = vi.hoisted(() => ({
  platform: "linux",
  serviceName: "paperclipai.service",
  definitionPath: "/tmp/paperclipai.service",
  install: vi.fn(async () => ({ changed: false })),
  uninstall: vi.fn(async () => undefined),
  start: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
  restart: vi.fn(async () => undefined),
  status: vi.fn(async () => ({ active: true, installed: true, pid: 1234 })),
}));

vi.mock("../service-lifecycle-authority.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../service-lifecycle-authority.js")>()),
  countActiveServiceRuns: vi.fn(async () => activeRuns.count),
}));
vi.mock("../services/service-manager.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/service-manager.js")>()),
  detectServiceManager: vi.fn(async () => ({ supported: true, manager })),
}));

const { registerServiceCommands } = await import("../commands/service.js");

function program(): Command {
  const root = new Command().exitOverride();
  registerServiceCommands(root);
  return root;
}
const run = (...args: string[]) => program().parseAsync(["node", "paperclipai", "service", ...args]);

let savedRunId: string | undefined;
let savedAgentId: string | undefined;
beforeEach(() => {
  savedRunId = process.env.PAPERCLIP_RUN_ID;
  savedAgentId = process.env.PAPERCLIP_AGENT_ID;
  delete process.env.PAPERCLIP_RUN_ID;
  delete process.env.PAPERCLIP_AGENT_ID;
  activeRuns.count = 0;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const fn of [manager.install, manager.uninstall, manager.start, manager.stop, manager.restart]) fn.mockClear();
  if (savedRunId === undefined) delete process.env.PAPERCLIP_RUN_ID; else process.env.PAPERCLIP_RUN_ID = savedRunId;
  if (savedAgentId === undefined) delete process.env.PAPERCLIP_AGENT_ID; else process.env.PAPERCLIP_AGENT_ID = savedAgentId;
});

describe("service commands under lifecycle authority", () => {
  it.each([["install"], ["uninstall"], ["start"], ["stop"], ["restart"], ["restart", "--wait"]])(
    "refuses `service %s` inside an agent run before touching the service manager",
    async (...args) => {
      process.env.PAPERCLIP_RUN_ID = "run-1";
      await expect(run(...args)).rejects.toThrow("from inside an agent run");
      for (const fn of [manager.install, manager.uninstall, manager.start, manager.stop, manager.restart]) {
        expect(fn).not.toHaveBeenCalled();
      }
    },
  );

  it.each([["stop", manager.stop], ["uninstall", manager.uninstall], ["restart", manager.restart]] as const)(
    "refuses `service %s` while the active service has running runs",
    async (verb, fn) => {
      activeRuns.count = 3;
      await expect(run(verb)).rejects.toThrow("while 3 agent runs are running on the active service");
      expect(fn).not.toHaveBeenCalled();
    },
  );

  it("still allows status and a quiet stop", async () => {
    await run("stop");
    expect(manager.stop).toHaveBeenCalledOnce();
    activeRuns.count = 2;
    await run("start");
    expect(manager.start).toHaveBeenCalledOnce();
  });
});
