import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";

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
const cleanup = { kind: "terminal_result_cleanup", stopped: true, terminalResultSeen: true, orderedOutputObserved: true, stopReason: "unmanaged_background_task_stopped", reason: "unmanaged background task stopped; no durable live path", signal: "SIGTERM", forceKilled: false } as const;
const dirs: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  runAdapterExecutionTargetProcess.mockReset();
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
// Upgrade-harness port (claude-terminal-cleanup). The original cases fed
// scripted output to the fork-only latest-turn tracker or to runChildProcess
// with it. Here the same scripted provider output runs as a real child process
// through the real execute() wiring, so the adapter's own terminal-result
// cleanup options decide the outcome on both upstream and the fork.
const REAL_TEST_TIMEOUT_MS = 10_000;
const emit = (record: Record<string, unknown>) => `process.stdout.write(${JSON.stringify(JSON.stringify(record) + "\n")});`;
async function adaptReal(script: string, config: Record<string, unknown> = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-terminal-real-"));
  dirs.push(dir);
  vi.stubEnv("PAPERCLIP_HOME", dir);
  const fixture = path.join(dir, "fixture-provider.cjs");
  // A bounded safety exit: a fixture that is never stopped still ends the test.
  await writeFile(fixture, `#!${process.execPath}\nsetTimeout(() => process.exit(97), 6000);\n${script}\n`, { mode: 0o755 });
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>("@paperclipai/adapter-utils/execution-target");
  runAdapterExecutionTargetProcess.mockImplementation(actual.runAdapterExecutionTargetProcess);
  const logs = { stdout: "", stderr: "" };
  const result = await execute({
    runId: randomUUID(),
    agent: { id: "agent", companyId: "company", name: "Fixture", adapterType: "claude_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { engine: "cli", command: fixture, cwd: dir, paperclipRuntimeSkills: [], graceSec: 1, terminalResultCleanupGraceMs: 200, ...config },
    context: {}, onLog: async (stream: "stdout" | "stderr", chunk: string) => { logs[stream] += chunk; },
  });
  return { result, logs };
}
describe("Claude terminal-result cleanup disposition", () => {
  it.skipIf(process.platform === "win32")("finalizes a real successful terminal result whose lingering process is cleaned up", async () => {
    const { result } = await adaptReal(`${emit(success)} setInterval(() => {}, 1000);`);
    expect(result).toMatchObject({ exitCode: 0, signal: null, timedOut: false, errorMessage: null, errorCode: null, sessionId: "cleanup-session" });
    expect(result.resultJson?.unmanagedBackgroundTask).toMatchObject({ stopped: true, signal: "SIGTERM", terminalResultSeen: true });
    expect(result.resultJson?.adapterCompletion).toMatchObject({ reason: "successful_terminal_result_cleanup", processExitCode: null, processSignal: "SIGTERM" });
    // Heartbeat's unchanged process-success gate now accepts the adapter result.
    expect((result.exitCode ?? 0) === 0 && !result.errorMessage && !result.signal).toBe(true);
  }, REAL_TEST_TIMEOUT_MS);
  it("preserves successful cleanup evidence when escalation was required", async () => {
    const result = await adapt({ signal: "SIGKILL", terminalResultCleanup: { ...cleanup, signal: "SIGKILL", forceKilled: true } });
    expect(result).toMatchObject({ exitCode: 0, signal: null });
    expect(result.resultJson?.unmanagedBackgroundTask).toMatchObject({ signal: "SIGKILL", forceKilled: true });
  });
  it.each([
    ["no controller cleanup", { terminalResultCleanup: null }],
    ["no ordered observation through close", { terminalResultCleanup: { ...cleanup, orderedOutputObserved: undefined } }],
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
    const { result } = await adaptReal([
      emit(success),
      `setTimeout(() => { ${emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "pending" }] } })} }, 10);`,
      "setTimeout(() => process.exit(3), 700);",
    ].join("\n"));
    expect(result).toMatchObject({ exitCode: 3, signal: null });
    expect(result.resultJson?.unmanagedBackgroundTask).toBeUndefined();
    expect(result.resultJson?.adapterCompletion).toBeUndefined();
  }, REAL_TEST_TIMEOUT_MS);
  it.skipIf(process.platform === "win32")("rearms cleanup only after a later turn emits its own result", async () => {
    const { result, logs } = await adaptReal([
      emit(success),
      `setTimeout(() => { ${emit({ type: "assistant", message: { content: [] } })} }, 10);`,
      `setTimeout(() => { ${emit({ ...success, result: "second complete" })} }, 700);`,
      "setInterval(() => {}, 1000);",
    ].join("\n"));
    expect(logs.stdout).toContain("second complete");
    expect(result).toMatchObject({ exitCode: 0, signal: null, summary: "second complete" });
  }, REAL_TEST_TIMEOUT_MS);

  it.skipIf(process.platform === "win32")("preserves failure for stderr after cleanup SIGTERM and escalation", async () => {
    const { result, logs } = await adaptReal([
      "process.on('SIGTERM', () => process.stderr.write('unfinished activity after SIGTERM\\n'));",
      emit(success),
      "setInterval(() => {}, 1000);",
    ].join("\n"));
    expect(result.signal).toBe("SIGKILL");
    expect(logs.stderr).toContain("unfinished activity after SIGTERM");
    expect(result.resultJson?.unmanagedBackgroundTask).toMatchObject({ orderedOutputObserved: true, terminalResultSeen: false, forceKilled: true });
    expect(result.resultJson?.adapterCompletion).toBeUndefined();
  }, REAL_TEST_TIMEOUT_MS);

  it.skipIf(process.platform === "win32")("does not accept a clean process exit after interrupted cleanup activity", async () => {
    const { result } = await adaptReal([
      "process.on('SIGTERM', () => { process.stderr.write('new unfinished activity\\n'); process.exit(0); });",
      emit(success),
      "setInterval(() => {}, 1000);",
    ].join("\n"));
    expect(result).toMatchObject({ exitCode: 0, signal: null });
    expect(result.errorCode).toBe("unmanaged_background_task_stopped");
    expect(result.errorMessage).toContain("completion is unproven");
    expect(result.resultJson?.unmanagedBackgroundTask).toMatchObject({ orderedOutputObserved: true, terminalResultSeen: false });
    expect(result.resultJson?.adapterCompletion).toBeUndefined();
  }, REAL_TEST_TIMEOUT_MS);

  it.skipIf(process.platform === "win32").each([0, 1])("keeps capture-evicted cleanup in reconciliation disposition for exit %i", async exitCode => {
    const { result } = await adaptReal([
      `process.on('SIGTERM', () => process.stdout.write('x'.repeat(4 * 1024 * 1024 + 4096), () => process.stderr.write('service unavailable\\n', () => process.exit(${exitCode}))));`,
      emit(success),
      "setInterval(() => {}, 1000);",
    ].join("\n"), { graceSec: 2 });
    expect(result.exitCode).toBe(exitCode);
    expect(result.errorCode).toBe("unmanaged_background_task_stopped");
    expect(result.errorMessage).toContain("completion is unproven");
    expect(result.errorFamily).toBeNull();
    expect(result.retryNotBefore ?? null).toBeNull();
    expect(result.resultJson?.unmanagedBackgroundTask ?? null).toMatchObject({ orderedOutputObserved: true, terminalResultSeen: false });
  }, REAL_TEST_TIMEOUT_MS);
  it.each(["429 rate limit", "service unavailable"])("does not infer retry from unparsed incomplete-cleanup prose %s", async stderr => {
    const result = await adapt({
      exitCode: 1, signal: null, stdout: "evicted terminal frame", stderr,
      terminalResultCleanup: { ...cleanup, terminalResultSeen: false },
    });
    expect(result.errorCode).toBe("unmanaged_background_task_stopped");
    expect(result.errorFamily).toBeNull();
    expect(result.retryNotBefore ?? null).toBeNull();
  });
  it.each([
    [{ errorCode: "duplex_channel_lost" }, "duplex_channel_lost"],
    [{ timedOut: true }, "timeout"],
  ])("preserves stronger unparsed precedence %j", async (extra, code) => {
    const result = await adapt({
      exitCode: 1, signal: null, stdout: "evicted terminal frame", stderr: "429 service unavailable",
      terminalResultCleanup: { ...cleanup, terminalResultSeen: false }, ...extra,
    });
    expect(result.errorCode).toBe(code);
    expect(result.retryNotBefore ?? null).toBeNull();
  });

});
