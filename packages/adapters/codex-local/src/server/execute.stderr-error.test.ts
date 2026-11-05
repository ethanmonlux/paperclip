import { beforeEach, describe, expect, it, vi } from "vitest";

const YOLO_WARNING = "YOLO mode is enabled. All tool calls will be automatically approved.";

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  prepareCodexRuntimeConfig,
  readPaperclipRuntimeSkillEntries,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  tempCodexHome,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  prepareCodexRuntimeConfig: vi.fn(async () => ({ cleanup: vi.fn(async () => undefined), notes: [] })),
  readPaperclipRuntimeSkillEntries: vi.fn(async () => []),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "codex"),
  runAdapterExecutionTargetProcess: vi.fn(),
  tempCodexHome: "/tmp/paperclip-codex-stderr-error-test-home",
}));

vi.mock("./acp.js", () => ({
  createCodexAcpExecutor: () => vi.fn(),
  formatCodexAcpFallbackMessage: (reason: string) =>
    `[paperclip] Codex ACP default unavailable; falling back to Codex CLI. ${reason} Set engine=acp to require ACP or engine=cli to silence this fallback.\n`,
  resolveCodexExecutionEngineForRun: async () => ({ engine: "cli", explicit: true }),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable,
    ensureAdapterExecutionTargetRuntimeCommandInstalled,
    resolveAdapterExecutionTargetCommandForLogs,
    runAdapterExecutionTargetProcess,
  };
});

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    readPaperclipRuntimeSkillEntries,
  };
});

vi.mock("./codex-home.js", async () => {
  const actual = await vi.importActual<typeof import("./codex-home.js")>("./codex-home.js");
  return {
    ...actual,
    evaluateCodexCredentialReadiness: vi.fn(async () => ({
      managed: true,
      authMode: "api",
      ready: true,
      effectiveHome: tempCodexHome,
      sharedSourceHome: tempCodexHome,
    })),
    isManagedCodexHomePath: vi.fn(() => true),
    prepareManagedCodexHome: vi.fn(async () => ({ status: "seeded", home: tempCodexHome })),
    resolveManagedCodexHomeDir: vi.fn(() => tempCodexHome),
    seedManagedCodexHome: vi.fn(async () => ({ status: "seeded", home: tempCodexHome })),
  };
});

vi.mock("./runtime-config.js", async () => {
  const actual = await vi.importActual<typeof import("./runtime-config.js")>("./runtime-config.js");
  return {
    ...actual,
    prepareCodexRuntimeConfig,
  };
});

import { execute, firstMeaningfulStderrLine } from "./execute.js";

function mockFailedProcess(stderr: string) {
  runAdapterExecutionTargetProcess.mockImplementation(async () => ({
    exitCode: 1,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr,
    pid: 123,
    startedAt: new Date().toISOString(),
  }));
}

function buildContext(config: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Codex Coder",
      adapterType: "codex_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      outputInactivityTimeoutMs: null,
      env: { OPENAI_API_KEY: "test-key" },
      ...config,
    },
    context: {},
    onLog: vi.fn(async () => {}),
  };
}

describe("codex_local stderr fallback error derivation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips the benign YOLO approvals warning and surfaces the real stderr error", async () => {
    mockFailedProcess(
      [
        YOLO_WARNING,
        "Error: unexpected status 400 Bad Request: {\"error\":{\"message\":\"The requested model 'gpt-5.3-codex-spark' does not exist.\",\"code\":\"model_not_found\"}}",
      ].join("\n"),
    );

    const result = await execute(buildContext() as never);

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("model_not_found");
    expect(result.errorMessage).not.toContain("YOLO mode");
  });

  it("skips adapter-injected [paperclip] diagnostic lines when picking the fallback error", async () => {
    mockFailedProcess(
      [
        "[paperclip] Codex ACP default unavailable; falling back to Codex CLI. Set engine=acp to require ACP or engine=cli to silence this fallback.",
        YOLO_WARNING,
        "Error: stream disconnected before completion",
      ].join("\n"),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorMessage).toBe("Error: stream disconnected before completion");
  });

  it("falls back to the first non-empty stderr line when every line is benign", async () => {
    mockFailedProcess(`${YOLO_WARNING}\n`);

    const result = await execute(buildContext() as never);

    expect(result.errorMessage).toBe(YOLO_WARNING);
  });

  it("falls back to the exit-code message when stderr is empty", async () => {
    mockFailedProcess("\n  \n");

    const result = await execute(buildContext() as never);

    expect(result.errorMessage).toBe("Codex exited with code 1");
  });
});

describe("codex_local stderr fallback diagnostic provenance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const toolRecord = (content: string) => JSON.stringify({ type: "tool_result", content });

  it.each([
    ["OAuth failed: invalid_grant"],
    ["refresh token has been invalidated"],
    ["refresh_token_reused"],
  ])("does not classify a structured stderr tool record quoting %s as authentication", async (quoted) => {
    mockFailedProcess(`${YOLO_WARNING}\n${toolRecord(quoted)}`);

    const result = await execute(buildContext() as never);

    expect(result.exitCode).toBe(1);
    expect(result.errorCode ?? null).toBeNull();
    expect(result.errorFamily ?? null).toBeNull();
    expect(result.errorMessage).not.toContain("tool_result");
    expect(result.errorMessage).not.toContain(quoted);
  });

  it("does not classify quoted quota or reset text in a structured stderr record as provider quota", async () => {
    mockFailedProcess(
      toolRecord("You've hit your usage limit for GPT-5. Switch to another model now, or try again at 4:00 PM."),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode ?? null).toBeNull();
    expect(result.errorFamily ?? null).toBeNull();
    expect(result.retryNotBefore ?? null).toBeNull();
  });

  it.each([
    ["compact", undefined],
    ["pretty-printed", 2],
  ])("does not classify quoted high-demand text in a %s stderr record as transient upstream", async (_label, indent) => {
    mockFailedProcess(JSON.stringify({
      type: "tool_result",
      content: "remote compact task: We're currently experiencing high demand",
    }, null, indent));

    const result = await execute(buildContext() as never);

    expect(result.errorCode ?? null).toBeNull();
    expect(result.errorFamily ?? null).toBeNull();
  });

  it("keeps a genuine plain CLI stderr authentication failure", async () => {
    mockFailedProcess(`${YOLO_WARNING}\nError: refresh token has been invalidated. Please log in again.`);

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("refresh_token_invalidated");
    expect(result.errorFamily).toBe("refresh_token_invalidated");
    expect(result.errorMessage).toBe("Error: refresh token has been invalidated. Please log in again.");
  });

  it("keeps a genuine plain CLI authentication failure after an adapter note", async () => {
    mockFailedProcess(
      "[paperclip] Confining Codex with workspace scope.\nError: refresh token has been invalidated. Please log in again.",
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("refresh_token_invalidated");
    expect(result.errorMessage).toBe("Error: refresh token has been invalidated. Please log in again.");
  });

  it("keeps a terminal JSON stderr authentication error", async () => {
    mockFailedProcess(JSON.stringify({ type: "error", message: "unexpected status 401 Unauthorized: invalid_grant" }));

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("refresh_token_invalidated");
    expect(result.errorMessage).toBe("unexpected status 401 Unauthorized: invalid_grant");
  });

  it("keeps a terminal JSON stdout authentication error ahead of untrusted stderr", async () => {
    runAdapterExecutionTargetProcess.mockImplementation(async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: `${JSON.stringify({ type: "turn.failed", error: { message: "refresh_token_reused" } })}\n`,
      stderr: toolRecord("model at capacity"),
      pid: 123,
      startedAt: new Date().toISOString(),
    }));

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("refresh_token_reused");
    expect(result.errorMessage).toBe("refresh_token_reused");
  });

  it("keeps genuine plain CLI quota reset and transient upstream controls", async () => {
    mockFailedProcess(
      "Error: You've hit your usage limit for GPT-5. Switch to another model now, or try again at 4:00 PM.",
    );
    const quota = await execute(buildContext() as never);
    expect(quota.errorCode).toBe("provider_quota");
    expect(quota.retryNotBefore).toEqual(expect.any(String));

    mockFailedProcess("Error: remote compact task failed: We're currently experiencing high demand");
    const transient = await execute(buildContext() as never);
    expect(transient.errorCode).toBe("codex_transient_upstream");
  });
});

describe("firstMeaningfulStderrLine", () => {
  it("returns the first line that is not a known benign warning", () => {
    expect(firstMeaningfulStderrLine(`${YOLO_WARNING}\nError: boom`)).toBe("Error: boom");
    expect(firstMeaningfulStderrLine("[paperclip] Confining Codex with workspace scope.\nError: boom")).toBe(
      "Error: boom",
    );
  });

  it("keeps the first non-empty line when all lines are benign", () => {
    expect(firstMeaningfulStderrLine(`${YOLO_WARNING}\n[paperclip] note\n`)).toBe(YOLO_WARNING);
  });

  it("returns an empty string for blank input", () => {
    expect(firstMeaningfulStderrLine("")).toBe("");
    expect(firstMeaningfulStderrLine(" \n\t\n")).toBe("");
  });
});
