import { describe, expect, it } from "vitest";
import { isUnfinishedAdapterCrashRun } from "./unfinished-crash.js";

describe("unfinished adapter crash (FAC-840 bounded retry)", () => {
  it("STA-153 replay: exit 0 with unparseable output takes the bounded retry", () => {
    expect(isUnfinishedAdapterCrashRun({ status: "failed", errorCode: "adapter_failed", exitCode: 0, signal: null })).toBe(true);
  });

  it("a signal-killed run with no result takes the bounded retry", () => {
    expect(isUnfinishedAdapterCrashRun({ status: "failed", errorCode: "adapter_failed", exitCode: null, signal: "SIGKILL" })).toBe(true);
  });

  it("keeps named failures and real non-zero exits on their own handling", () => {
    expect(isUnfinishedAdapterCrashRun({ status: "failed", errorCode: "model_not_found", exitCode: 0, signal: null })).toBe(false);
    expect(isUnfinishedAdapterCrashRun({ status: "failed", errorCode: "claude_auth_required", exitCode: 0, signal: null })).toBe(false);
    expect(isUnfinishedAdapterCrashRun({ status: "failed", errorCode: "adapter_failed", exitCode: 1, signal: null })).toBe(false);
    expect(isUnfinishedAdapterCrashRun({ status: "cancelled", errorCode: "adapter_failed", exitCode: 0, signal: "SIGTERM" })).toBe(false);
  });
});
