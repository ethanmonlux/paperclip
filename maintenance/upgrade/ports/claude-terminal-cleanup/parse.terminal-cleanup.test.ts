import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

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

const dirs: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  runAdapterExecutionTargetProcess.mockReset();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
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
// The original record from parse.terminal-cleanup.test.ts, with the fields the
// adapter needs to report a session and summary.
const result = { type: "result", subtype: "success", is_error: false, session_id: "cleanup-session", result: "Work recorded", usage: { input_tokens: 1, output_tokens: 2 }, queued_turn_count: 0 };
const write = (text: string) => `process.stdout.write(${JSON.stringify(text)});`;
const normalized = (outcome: Awaited<ReturnType<typeof adaptReal>>["result"]) =>
  outcome.exitCode === 0 && outcome.signal === null && outcome.resultJson?.adapterCompletion !== undefined;
describe("latest Claude terminal turn", () => {
 it("accepts a completed task-notification with settled background counts", async () => {
  const { result: outcome } = await adaptReal([
   emit({ ...result, origin: { kind: "task-notification" }, subagent_stats: { spawned: 3, completed: 3, failed: 0, killed: { user: 0, parent: 0, system: 0 } } }),
   "setInterval(() => {}, 1000);",
  ].join("\n"));
  expect(outcome.resultJson?.adapterCompletion).toMatchObject({ reason: "successful_terminal_result_cleanup" });
  expect(normalized(outcome)).toBe(true);
 }, REAL_TEST_TIMEOUT_MS);
 it("invalidates on fragmented next-turn output and accepts its later result", async () => {
  const { result: outcome } = await adaptReal([
   emit(result),
   `setTimeout(() => { ${write('{"type":"assis')} }, 10);`,
   `setTimeout(() => { ${write('tant","message":{}}\n')} }, 40);`,
   `setTimeout(() => { ${write(JSON.stringify({ ...result, result: "later turn" }))} }, 700);`,
   "setInterval(() => {}, 1000);",
  ].join("\n"));
  expect(outcome).toMatchObject({ exitCode: 0, signal: null, summary: "later turn" });
 }, REAL_TEST_TIMEOUT_MS);
 it("does not revive an older result after unknown/truncated activity", async () => {
  for (const activity of ['{"type":"assistant"', "not-json\n"]) {
   const { result: outcome } = await adaptReal([
    emit(result),
    `setTimeout(() => { ${write(activity)} }, 10);`,
    "setTimeout(() => process.exit(4), 700);",
   ].join("\n"));
   expect(outcome).toMatchObject({ exitCode: 4, signal: null });
   expect(outcome.resultJson?.unmanagedBackgroundTask).toBeUndefined();
   expect(outcome.resultJson?.adapterCompletion).toBeUndefined();
  }
 }, REAL_TEST_TIMEOUT_MS);
 it("does not treat a rate limit telemetry event as a new turn", async () => {
  const { result: outcome } = await adaptReal([
   emit(result),
   `setTimeout(() => { ${write('{"type":"rate_')} }, 10);`,
   `setTimeout(() => { ${write('limit_event"}\n')} }, 40);`,
   "setInterval(() => {}, 1000);",
  ].join("\n"));
  expect(normalized(outcome)).toBe(true);
 }, REAL_TEST_TIMEOUT_MS);
 it("invalidates on stderr activity until a new result", async () => {
  const { result: outcome } = await adaptReal([
   emit(result),
   "setTimeout(() => process.stderr.write('later error'), 10);",
   `setTimeout(() => { ${emit({ ...result, result: "after stderr" })} }, 700);`,
   "setInterval(() => {}, 1000);",
  ].join("\n"));
  expect(outcome).toMatchObject({ exitCode: 0, signal: null, summary: "after stderr" });
 }, REAL_TEST_TIMEOUT_MS);
 it("keeps fragmented oversized activity invalid after its discarded newline", async () => {
  const { result: outcome } = await adaptReal([
   emit(result),
   "setTimeout(() => process.stdout.write('{\"type\":\"assistant\",\"message\":{\"text\":\"' + 'x'.repeat(4 * 1024 * 1024 + 1),",
   `  () => process.stdout.write('"}}\\n', () => process.stdout.write('\\n', () => setTimeout(() => { ${emit({ ...result, result: "after oversized" })} }, 700)))), 10);`,
   "setInterval(() => {}, 1000);",
  ].join("\n"));
  expect(outcome).toMatchObject({ exitCode: 0, signal: null, summary: "after oversized" });
 }, REAL_TEST_TIMEOUT_MS);
 it("does not retain unbounded whitespace as a pending record", async () => {
  // Cleanup is armed by the first result. The whitespace must not hide the
  // assistant record that follows it, so that record still cancels cleanup.
  const { result: outcome } = await adaptReal([
   emit(result),
   "const spaces = ' '.repeat(4 * 1024 * 1024);",
   `setTimeout(() => process.stdout.write(spaces, () => process.stdout.write(spaces, () => process.stdout.write(spaces, () => { ${write('{"type":"assistant"}\n')} }))), 10);`,
   "setTimeout(() => process.exit(5), 2500);",
  ].join("\n"), { terminalResultCleanupGraceMs: 1500 });
  expect(outcome).toMatchObject({ exitCode: 5, signal: null });
  expect(outcome.resultJson?.unmanagedBackgroundTask).toBeUndefined();
 }, REAL_TEST_TIMEOUT_MS);

});
