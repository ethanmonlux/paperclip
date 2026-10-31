import { describe, expect, it } from "vitest";
import { createClaudeTerminalResultTracker, hasCurrentClaudeTerminalResult } from "./parse.js";
const result = { type: "result", subtype: "success", queued_turn_count: 0 };
describe("latest Claude terminal turn", () => {
 it("accepts a completed task-notification with settled background counts", () => {
  expect(hasCurrentClaudeTerminalResult(JSON.stringify({ ...result, origin: { kind: "task-notification" }, subagent_stats: { spawned: 3, completed: 3, failed: 0, killed: { user: 0, parent: 0, system: 0 } } }))).toBe(true);
 });
 it("invalidates on fragmented next-turn output and accepts its later result", () => {
  const observe = createClaudeTerminalResultTracker();
  expect(observe({ stdout: JSON.stringify(result)+"\n", stderr: "" })).toBe(true);
  expect(observe({ stdout: '{"type":"assis', stderr: "" })).toBe(false);
  expect(observe({ stdout: 'tant","message":{}}\n', stderr: "" })).toBe(false);
  expect(observe({ stdout: JSON.stringify(result), stderr: "" })).toBe(true);
 });
 it("does not revive an older result after unknown/truncated activity", () => {
  expect(hasCurrentClaudeTerminalResult(JSON.stringify(result)+'\n{"type":"assistant"')).toBe(false);
  expect(hasCurrentClaudeTerminalResult(JSON.stringify(result)+"\nnot-json\n")).toBe(false);
 });
 it("does not treat a rate limit telemetry event as a new turn", () => {
  const observe = createClaudeTerminalResultTracker();
  expect(observe({ stdout: JSON.stringify(result)+"\n", stderr: "" })).toBe(true);
  expect(observe({ stdout: '{"type":"rate_', stderr: "" })).toBe(false);
  expect(observe({ stdout: 'limit_event"}\n', stderr: "" })).toBe(true);
 });
 it("invalidates on stderr activity until a new result", () => {
  const observe = createClaudeTerminalResultTracker();
  expect(observe({ stdout: JSON.stringify(result)+"\n", stderr: "" })).toBe(true);
  expect(observe({ stdout: "", stderr: "later error" })).toBe(false);
  expect(observe({ stdout: JSON.stringify(result)+"\n", stderr: "" })).toBe(true);
 });
});
