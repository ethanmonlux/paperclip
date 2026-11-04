import { describe, expect, it } from "vitest";
import {
  classifyCodexAuthRefreshFailure,
  codexAcpFailureDiagnostic,
  extractCodexDiagnosticText,
  extractCodexRetryNotBefore,
  isCodexHarnessCrash,
  isCodexProviderQuotaError,
  isCodexTransientUpstreamError,
  isCodexUnknownSessionError,
  parseCodexJsonl,
} from "./parse.js";

// Provider text as admitted from an untyped ACP turn failure.
const provider = (message: string) =>
  codexAcpFailureDiagnostic({ exitCode: 1, timedOut: false, errorCode: "acpx_turn_failed", errorMessage: message });

describe("parseCodexJsonl", () => {
  it.each(["turn.failed", "error", "turn.completed"])("does not invent zero usage for %s without counters", (type) => {
    expect(parseCodexJsonl(JSON.stringify({ type }))).toMatchObject({
      sawProtocolTerminalEvent: true, usageReported: false, usageComplete: false,
    });
  });
  it.each([{}, { input_tokens: 0 }, { input_tokens: -1, output_tokens: 0 }, { input_tokens: 1, output_tokens: 0, cached_input_tokens: 2 }])("rejects missing or invalid completion counters: %j", (usage) => {
    expect(parseCodexJsonl(JSON.stringify({ type: "turn.completed", usage })).usageComplete).toBe(false);
  });
  it("distinguishes explicit zero usage from missing usage", () => {
    expect(parseCodexJsonl(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 0, output_tokens: 0 } }))).toMatchObject({
      usageReported: true, usageComplete: true, usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    });
  });
  it("captures session id, assistant summary, usage, and error message", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_123" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Recovered response" },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 4 },
      }),
      JSON.stringify({ type: "turn.failed", error: { message: "resume failed" } }),
    ].join("\n");

    expect(parseCodexJsonl(stdout)).toEqual({
      sessionId: "thread_123",
      summary: "Recovered response",
      usage: {
        inputTokens: 8,
        cachedInputTokens: 2,
        outputTokens: 4,
      },
      usageBasis: "per_run",
      errorMessage: "resume failed",
      sawProtocolEvent: true,
      sawProtocolTerminalEvent: true,
      usageReported: true,
      usageComplete: false,
    });
  });

  it("uses the last agent message as the summary when commentary updates precede the final answer", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_123" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "reasoning", text: "Checking the heartbeat procedure" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "I’m checking out the issue and reading the docs now." },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Fixed the issue and verified the targeted tests pass." },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 4 },
      }),
    ].join("\n");

    expect(parseCodexJsonl(stdout)).toEqual({
      sessionId: "thread_123",
      summary: "Fixed the issue and verified the targeted tests pass.",
      usage: {
        inputTokens: 8,
        cachedInputTokens: 2,
        outputTokens: 4,
      },
      usageBasis: "per_run",
      errorMessage: null,
      sawProtocolEvent: true,
      sawProtocolTerminalEvent: true,
      usageReported: true,
      usageComplete: true,
    });
  });
});

describe("isCodexHarnessCrash", () => {
  const crashedMidTurnStream = [
    JSON.stringify({ type: "thread.started", thread_id: "thread_123" }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "Checking out the issue now." },
    }),
    JSON.stringify({ type: "item.started", item: { type: "command_execution" } }),
  ].join("\n");

  it("classifies a nonzero exit with no protocol-terminal event as a harness crash", () => {
    const parsed = parseCodexJsonl(crashedMidTurnStream);
    expect(parsed.sawProtocolEvent).toBe(true);
    expect(parsed.sawProtocolTerminalEvent).toBe(false);
    expect(isCodexHarnessCrash({ exitCode: 1, ...parsed })).toBe(true);
  });

  it("does not classify runs whose turn reached a protocol-terminal event", () => {
    const failedInProtocol = parseCodexJsonl(
      [
        JSON.stringify({ type: "thread.started", thread_id: "thread_123" }),
        JSON.stringify({ type: "turn.failed", error: { message: "the model rejected the request" } }),
      ].join("\n"),
    );
    expect(isCodexHarnessCrash({ exitCode: 1, ...failedInProtocol })).toBe(false);

    const completedThenFailedExit = parseCodexJsonl(
      [
        JSON.stringify({ type: "thread.started", thread_id: "thread_123" }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 4 },
        }),
      ].join("\n"),
    );
    expect(isCodexHarnessCrash({ exitCode: 1, ...completedThenFailedExit })).toBe(false);
  });

  it("does not classify successful exits or streams that never spoke the protocol", () => {
    expect(isCodexHarnessCrash({ exitCode: 0, ...parseCodexJsonl(crashedMidTurnStream) })).toBe(false);
    expect(isCodexHarnessCrash({ exitCode: null, ...parseCodexJsonl(crashedMidTurnStream) })).toBe(false);

    const neverStarted = parseCodexJsonl("error: unexpected argument '--bogus-flag'\n");
    expect(neverStarted.sawProtocolEvent).toBe(false);
    expect(isCodexHarnessCrash({ exitCode: 2, ...neverStarted })).toBe(false);
  });

  it("stays structural: agent output discussing network errors does not affect classification", () => {
    const parsed = parseCodexJsonl(
      [
        JSON.stringify({ type: "thread.started", thread_id: "thread_123" }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "The deploy failed with connection reset by peer; investigating." },
        }),
        JSON.stringify({ type: "turn.failed", error: { message: "agent gave up" } }),
      ].join("\n"),
    );
    expect(isCodexHarnessCrash({ exitCode: 1, ...parsed })).toBe(false);
    expect(
      isCodexTransientUpstreamError({
        stdout: "connection reset by peer while running the deploy",
        diagnostic: provider("agent gave up"),
      }),
    ).toBe(false);
  });
});

describe("classifyCodexAuthRefreshFailure", () => {
  it.each(["refresh_token_reused", "refresh_token_expired", "refresh_token_invalidated", "invalid_grant"])("keeps a capacity failure with quoted tool auth marker %s out of authentication recovery", marker => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-real-capacity" }),
      JSON.stringify({ type: "item.completed", item: { type: "command_execution", aggregated_output: "source audit fixture: " + marker, exit_code: 0, status: "completed" } }),
      JSON.stringify({ type: "turn.failed", error: { message: "Selected model is at capacity. Please try a different model." } }),
    ].join("\n");
    expect(classifyCodexAuthRefreshFailure({ stdout, stderr: "" })).toBeNull();
    expect(isCodexProviderQuotaError({ stdout, stderr: "" })).toBe(true);
  });

  it.each([
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", aggregated_output: "OAuth failed: invalid_grant" } }, null, 2),
    '{"type":"item.completed","item":{"type":"command_execution","aggregated_output":"refresh_token_invalidated',
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "The test expects refresh_token_reused." } }),
    JSON.stringify({ type: "tool_result", content: "credential refresh returned 401 Unauthorized" }),
  ])("ignores pretty, interrupted and quoted protocol output as auth evidence: %s", stdout => {
    expect(classifyCodexAuthRefreshFailure({ stdout, diagnostic: provider("Selected model is at capacity.") })).toBeNull();
    expect(classifyCodexAuthRefreshFailure({ stderr: stdout, diagnostic: provider("Selected model is at capacity.") })).toBeNull();
  });

  it.each([
    JSON.stringify({ type: "error", message: "OAuth failed: invalid_grant" }),
    JSON.stringify({ type: "turn.failed", error: { message: "OAuth failed: invalid_grant" } }, null, 2),
  ])("preserves a genuine terminal JSON authentication failure: %s", stdout => {
    expect(classifyCodexAuthRefreshFailure({ stdout })).toBe("refresh_token_invalidated");
  });

  it("keeps plain CLI stderr after an adapter note as diagnostic text", () => {
    const stderr = "[paperclip] Confining Codex with workspace scope.\nOAuth failed: refresh token has expired";
    expect(classifyCodexAuthRefreshFailure({ stderr })).toBe("refresh_token_expired");
    expect(extractCodexDiagnosticText(stderr)).toBe(stderr);
    expect(extractCodexDiagnosticText('[{"type":"tool_result"}]\nOAuth failed: invalid_grant')).toBe("");
  });

  it("classifies explicit refresh-token failure messages", () => {
    expect(classifyCodexAuthRefreshFailure({ diagnostic: provider("provider error: refresh_token_reused") })).toBe(
      "refresh_token_reused",
    );
    expect(classifyCodexAuthRefreshFailure({ stderr: "OAuth failed: refresh token has expired" })).toBe(
      "refresh_token_expired",
    );
    expect(classifyCodexAuthRefreshFailure({ stdout: "OAuth failed: invalid_grant" })).toBe(
      "refresh_token_invalidated",
    );
    expect(classifyCodexAuthRefreshFailure({ diagnostic: provider("credential refresh returned 401 Unauthorized") })).toBe(
      "refresh_token_invalidated",
    );
  });

  it("distinguishes an absent Authorization header from a revoked refresh token", () => {
    expect(classifyCodexAuthRefreshFailure({
      diagnostic: provider("unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses"),
    })).toBeNull();
    expect(classifyCodexAuthRefreshFailure({
      stderr: "401 Unauthorized: Missing bearer or basic authentication in header",
      stdout: "provider error: invalid_grant",
    })).toBe("refresh_token_invalidated");
  });

  it("does not classify bare 401 or quota messages as auth-refresh failures", () => {
    expect(classifyCodexAuthRefreshFailure({ diagnostic: provider("chatgpt wham api returned 401") })).toBeNull();
    expect(classifyCodexAuthRefreshFailure({ diagnostic: provider("You've hit your usage limit for GPT-5.") })).toBeNull();
  });
});

describe("isCodexUnknownSessionError", () => {
  it("detects the current missing-rollout thread error", () => {
    expect(
      isCodexUnknownSessionError(
        "",
        "Error: thread/resume: thread/resume failed: no rollout found for thread id d448e715-7607-4bcc-91fc-7a3c0c5a9632",
      ),
    ).toBe(true);
  });

  it("still detects existing stale-session wordings", () => {
    expect(isCodexUnknownSessionError("unknown thread id", "")).toBe(true);
    expect(isCodexUnknownSessionError("", "state db missing rollout path for thread abc")).toBe(true);
    expect(isCodexUnknownSessionError("", "state db returned stale rollout path for thread abc")).toBe(true);
  });

  it("does not classify unrelated Codex failures as stale sessions", () => {
    expect(isCodexUnknownSessionError("", "model overloaded")).toBe(false);
  });
});

describe("isCodexTransientUpstreamError", () => {
  it("classifies the remote-compaction high-demand failure as transient upstream", () => {
    expect(
      isCodexTransientUpstreamError({
        diagnostic: provider(
          "Error running remote compact task: We're currently experiencing high demand, which may cause temporary errors.",
        ),
      }),
    ).toBe(true);
    expect(
      isCodexTransientUpstreamError({
        stderr: "We're currently experiencing high demand, which may cause temporary errors.",
      }),
    ).toBe(true);
  });

  it("classifies usage-limit windows as provider quota and extracts the retry time", () => {
    const errorMessage = "You've hit your usage limit for GPT-5.3-Codex-Spark. Switch to another model now, or try again at 11:31 PM.";
    const now = new Date(2026, 3, 22, 22, 29, 2);

    expect(isCodexProviderQuotaError({ diagnostic: provider(errorMessage) })).toBe(true);
    expect(isCodexTransientUpstreamError({ diagnostic: provider(errorMessage) })).toBe(false);
    expect(extractCodexRetryNotBefore({ diagnostic: provider(errorMessage) }, now)?.getTime()).toBe(
      new Date(2026, 3, 22, 23, 31, 0, 0).getTime(),
    );
  });

  it("classifies model-capacity messages as provider quota without reset metadata", () => {
    const errorMessage = "The requested model is at capacity. Please try again later.";

    expect(isCodexProviderQuotaError({ diagnostic: provider(errorMessage) })).toBe(true);
    expect(isCodexTransientUpstreamError({ diagnostic: provider(errorMessage) })).toBe(false);
    expect(extractCodexRetryNotBefore({ diagnostic: provider(errorMessage) })).toBeNull();
  });

  it("parses explicit timezone hints on usage-limit retry windows", () => {
    const errorMessage = "You've hit your usage limit for GPT-5.3-Codex-Spark. Switch to another model now, or try again at 11:31 PM (America/Chicago).";
    const now = new Date("2026-04-23T03:29:02.000Z");

    expect(extractCodexRetryNotBefore({ diagnostic: provider(errorMessage) }, now)?.toISOString()).toBe(
      "2026-04-23T04:31:00.000Z",
    );
  });

  it("does not classify deterministic compaction errors as transient", () => {
    expect(
      isCodexTransientUpstreamError({
        diagnostic: provider([
          "Error running remote compact task: {",
          '  "error": {',
          '    "message": "Unknown parameter: \'prompt_cache_retention\'.",',
          '    "type": "invalid_request_error",',
          '    "param": "prompt_cache_retention",',
          '    "code": "unknown_parameter"',
          "  }",
          "}",
        ].join("\n")),
      }),
    ).toBe(false);
  });
});

describe("codexAcpFailureDiagnostic", () => {
  const base = { exitCode: 1, timedOut: false, errorMessage: "OAuth failed: refresh_token_reused" };

  it.each(["acpx_turn_failed", "acpx_auth_required", "acpx_session_init_failed", "acpx_session_config_failed", "acpx_protocol_error"])(
    "admits the provider message of an untyped %s failure",
    (errorCode) => {
      expect(classifyCodexAuthRefreshFailure({ diagnostic: codexAcpFailureDiagnostic({ ...base, errorCode }) }))
        .toBe("refresh_token_reused");
    },
  );

  it.each([
    ["typed transport", { errorCode: "duplex_channel_lost" }],
    ["typed timeout", { errorCode: "acpx_timeout", timedOut: true }],
    ["timed out turn", { errorCode: "acpx_turn_failed", timedOut: true }],
    ["stalled tool", { errorCode: "acpx_tool_stalled" }],
    ["handshake guard", { errorCode: "acpx_handshake_timeout" }],
    ["cancellation", { errorCode: "cancelled" }],
    ["typed capacity", { errorCode: "codex_transient_upstream" }],
    ["typed quota", { errorCode: "provider_quota" }],
    ["local runtime", { errorCode: "acpx_runtime_error" }],
    ["unclassified", { errorCode: null }],
    ["success", { errorCode: null, exitCode: 0 }],
  ])("keeps a %s outcome out of provider diagnostics", (_label, overrides) => {
    expect(codexAcpFailureDiagnostic({ ...base, ...overrides })).toBeNull();
  });
});
