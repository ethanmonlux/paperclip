import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runChildProcess, type RunProcessResult } from "@paperclipai/adapter-utils/server-utils";

const { runAdapterExecutionTargetProcess } = vi.hoisted(() => ({
  runAdapterExecutionTargetProcess: vi.fn(),
}));
vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>("@paperclipai/adapter-utils/execution-target");
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
    ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
    resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "fixture-provider"),
    runAdapterExecutionTargetProcess,
  };
});
import { execute } from "./execute.js";

const success = { type: "result", subtype: "success", is_error: false, session_id: "cleanup-session", result: "Work recorded", usage: { input_tokens: 1, output_tokens: 2 } };
const cleanup = { kind: "terminal_result_cleanup", stopped: true, terminalResultSeen: true, stopReason: "unmanaged_background_task_stopped", reason: "unmanaged background task stopped; no durable live path", signal: "SIGTERM", forceKilled: false } as const;
const dirs: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function adapt(overrides: Partial<RunProcessResult> = {}, result: Record<string, unknown> = success) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-terminal-adapter-"));
  dirs.push(dir);
  vi.stubEnv("PAPERCLIP_HOME", dir);
  runAdapterExecutionTargetProcess.mockResolvedValueOnce({
    exitCode: null, signal: "SIGTERM", timedOut: false,
    stdout: JSON.stringify(result), stderr: "", pid: 123, startedAt: new Date().toISOString(),
    terminalResultCleanup: cleanup, ...overrides,
  });
  return execute({
    runId: randomUUID(),
    agent: { id: "agent", companyId: "company", name: "Fixture", adapterType: "claude_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { engine: "cli", command: "fixture-provider", cwd: dir, paperclipRuntimeSkills: [] },
    context: {}, onLog: async () => {},
  });
}
describe("Claude terminal-result cleanup disposition", () => {
  it.skipIf(process.platform === "win32")("finalizes a real successful terminal result whose lingering process is cleaned up", async () => {
    const proc = await runChildProcess(randomUUID(), process.execPath, ["-e",
      "process.stdout.write(JSON.stringify(" + JSON.stringify(success) + ")+ '\\n');setInterval(()=>{},1000);"
    ], {
      cwd: os.tmpdir(), env: {}, timeoutSec: 5, graceSec: 1, onLog: async () => {},
      terminalResultCleanup: { graceMs: 50, hasTerminalResult: ({ stdout }) => stdout.includes('"subtype":"success"') },
    });
    expect(proc.signal).toBe("SIGTERM");
    expect(proc.terminalResultCleanup?.terminalResultSeen).toBe(true);
    const result = await adapt(proc);
    expect(result).toMatchObject({ exitCode: 0, signal: null, timedOut: false, errorMessage: null, errorCode: null, sessionId: "cleanup-session" });
    expect(result.resultJson?.unmanagedBackgroundTask).toMatchObject({ stopped: true, signal: "SIGTERM" });
    expect(result.resultJson?.adapterCompletion).toMatchObject({ reason: "successful_terminal_result_cleanup", processExitCode: null, processSignal: "SIGTERM" });
    // Heartbeat's unchanged process-success gate now accepts the adapter result.
    expect((result.exitCode ?? 0) === 0 && !result.errorMessage && !result.signal).toBe(true);
  });
  it("preserves successful cleanup evidence when escalation was required", async () => {
    const result = await adapt({ signal: "SIGKILL", terminalResultCleanup: { ...cleanup, signal: "SIGKILL", forceKilled: true } });
    expect(result).toMatchObject({ exitCode: 0, signal: null });
    expect(result.resultJson?.unmanagedBackgroundTask).toMatchObject({ signal: "SIGKILL", forceKilled: true });
  });
  it.each([
    ["no controller cleanup", { terminalResultCleanup: null }],
    ["no observed terminal result", { terminalResultCleanup: { ...cleanup, terminalResultSeen: false } }],
    ["different actual signal", { signal: "SIGKILL" }],
    ["independent nonzero exit", { exitCode: 2 }],
    ["transport failure", { errorCode: "duplex_channel_lost" }],
  ])("does not normalize %s", async (_name, input) => {
    const result = await adapt(input as Partial<RunProcessResult>);
    expect(result.resultJson?.adapterCompletion).toBeUndefined();
    expect((result.exitCode ?? 0) === 0 && !result.errorMessage && !result.signal).toBe(false);
  });
  it("preserves an error terminal result after cleanup", async () => {
    const result = await adapt({}, { ...success, subtype: "error_during_execution", is_error: true });
    expect(result.signal).toBe("SIGTERM");
    expect(result.errorMessage).toBeTruthy();
    expect(result.resultJson?.adapterCompletion).toBeUndefined();
  });
  it("preserves a structured refusal even if the subtype says success", async () => {
    const result = await adapt({}, { ...success, stop_reason: "refusal" });
    expect(result.errorCode).toBe("claude_refusal");
    expect(result.signal).toBe("SIGTERM");
    expect(result.resultJson?.adapterCompletion).toBeUndefined();
  });
  it("does not infer successful completion from a result without an explicit success subtype", async () => {
    const result = await adapt({}, { ...success, subtype: undefined });
    expect(result.signal).toBe("SIGTERM");
    expect(result.resultJson?.adapterCompletion).toBeUndefined();
  });
  it("preserves the task-notification origin from the reported incident", async () => {
    const result = await adapt({}, { ...success, origin: { kind: "task-notification", producer: "session-task" } });
    expect(result).toMatchObject({ exitCode: 0, signal: null });
    expect(result.resultJson?.origin).toEqual({ kind: "task-notification", producer: "session-task" });
  });
  it("preserves timeout precedence even with a prior success frame", async () => {
    const result = await adapt({ timedOut: true });
    expect(result.timedOut).toBe(true);
    expect(result.resultJson?.adapterCompletion).toBeUndefined();
  });
  it("does not normalize success followed by an unfinished assistant/tool turn", async () => {
    const stdout = JSON.stringify(success) + "\n" + JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "pending", name: "Bash" }] } }) + "\n";
    const result = await adapt({ stdout });
    expect(result.signal).toBe("SIGTERM");
    expect(result.resultJson?.adapterCompletion).toBeUndefined();
  });
  it.each([
    { queued_turn_count: 1 },
    { subagent_stats: { spawned: 2, completed: 1, failed: 0, killed: { user: 0, parent: 0, system: 0 } } },
    { subagent_stats: { pending: 1 } },
  ])("does not normalize unsettled result metadata %j", async metadata => {
    const result = await adapt({}, { ...success, ...metadata });
    expect(result.signal).toBe("SIGTERM");
    expect(result.resultJson?.adapterCompletion).toBeUndefined();
  });
  it("can normalize a later result after the intervening turn finishes", async () => {
    const stdout = [success, { type: "assistant", message: { content: [] } }, { ...success, result: "Latest turn complete", queued_turn_count: 0, subagent_stats: { spawned: 2, completed: 2 } }].map(x => JSON.stringify(x)).join("\n");
    expect(await adapt({ stdout })).toMatchObject({ exitCode: 0, signal: null, summary: "Latest turn complete" });
  });
  it.skipIf(process.platform === "win32")("cancels stale controller cleanup while a later turn is unfinished", async () => {
    const { createClaudeTerminalResultTracker } = await import("./parse.js");
    const observe = createClaudeTerminalResultTracker();
    const proc = await runChildProcess(randomUUID(), process.execPath, ["-e", [
      "process.stdout.write(JSON.stringify(" + JSON.stringify(success) + ")+ '\\n');",
      "setTimeout(()=>process.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'pending'}]}})+'\\n'),10);",
      "setTimeout(()=>process.exit(3),250);",
    ].join("")], {
      cwd: os.tmpdir(), env: {}, timeoutSec: 3, graceSec: 1, onLog: async () => {},
      terminalResultCleanup: { graceMs: 100, hasTerminalResult: () => false, observeOutput: observe },
    });
    expect(proc).toMatchObject({ exitCode: 3, signal: null, terminalResultCleanup: null });
  });
  it.skipIf(process.platform === "win32")("rearms cleanup only after a later turn emits its own result", async () => {
    const { createClaudeTerminalResultTracker } = await import("./parse.js");
    const observe = createClaudeTerminalResultTracker();
    const proc = await runChildProcess(randomUUID(), process.execPath, ["-e", [
      "const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');",
      "emit(" + JSON.stringify(success) + ");",
      "setTimeout(()=>emit({type:'assistant',message:{content:[]}}),10);",
      "setTimeout(()=>emit(" + JSON.stringify({ ...success, result: "second complete" }) + "),160);",
      "setInterval(()=>{},1000);",
    ].join("")], {
      cwd: os.tmpdir(), env: {}, timeoutSec: 3, graceSec: 1, onLog: async () => {},
      terminalResultCleanup: { graceMs: 100, hasTerminalResult: () => false, observeOutput: observe },
    });
    expect(proc.signal).toBe("SIGTERM");
    expect(proc.stdout).toContain("second complete");
    expect(await adapt(proc)).toMatchObject({ exitCode: 0, signal: null, summary: "second complete" });
  });

});
