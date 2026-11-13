import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "./execute.js";

// STA-360 replay of STA-310 run c85e60bb: the agent started its tests with
// run_in_background, ended the turn ("will check the result when it
// finishes"), and the CLI stayed alive waiting for the task. The
// terminal-result cleanup stopped it with SIGTERM and the run was recorded
// adapter_failed, three times, until the retry budget ran out.
const FIXTURE = new URL("./__fixtures__/claude-turn-ends-with-live-background-task.jsonl", import.meta.url);

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function writeLingeringClaudeCommand(
  commandPath: string,
  input: { stdout: string; capturePath: string; onSigterm?: string },
): Promise<void> {
  // Prints the stream, then stays alive like a CLI waiting on a background task.
  // `onSigterm` replaces the default signal exit to simulate a faulty shutdown.
  const script = `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("2.1.312 (Claude Code)"); process.exit(0); }
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(input.capturePath)}, JSON.stringify({
  argv: process.argv.slice(2),
  disableBackgroundTasks: process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS ?? null,
}));
process.stdout.write(${JSON.stringify(input.stdout)});
${input.onSigterm ? `process.on("SIGTERM", () => { ${input.onSigterm} });` : ""}
setInterval(() => {}, 1000);
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function runLingeringClaude(
  stdout: string,
  options: { env?: Record<string, string>; onSigterm?: string } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-background-task-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  const commandPath = path.join(root, "claude");
  const capturePath = path.join(root, "capture.json");
  await fs.mkdir(workspace, { recursive: true });
  await writeLingeringClaudeCommand(commandPath, { stdout, capturePath, onSigterm: options.onSigterm });

  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const result = await execute({
      runId: "run-claude-background-task",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: { engine: "cli" },
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        engine: "cli",
        command: commandPath,
        cwd: workspace,
        promptTemplate: "Follow the paperclip heartbeat.",
        terminalResultCleanupGraceMs: 50,
        ...(options.env ? { env: options.env } : {}),
      },
      context: {},
      authToken: "run-jwt-token",
      onLog: async () => {},
    } as never);
    const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
      argv: string[];
      disableBackgroundTasks: string | null;
    };
    return { result, capture };
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
}

describe("claude_local turn that ends with a live background task", () => {
  it("launches the CLI with background tasks and Monitor disabled", async () => {
    const { capture } = await runLingeringClaude(await fs.readFile(FIXTURE, "utf8"));

    expect(capture.disableBackgroundTasks).toBe("1");
    expect(capture.argv).toContain("--disallowedTools=Monitor");
  });

  it("reports the finished turn instead of the cleanup stop, keeping the stop as evidence", async () => {
    const { result } = await runLingeringClaude(await fs.readFile(FIXTURE, "utf8"));

    // run-completion records `succeeded` only when the exit code is 0 or null,
    // there is no error message and no signal; otherwise it records
    // adapter_failed. A succeeded run with this evidence takes the
    // successful-run handoff, which continues the task.
    expect(result.exitCode ?? 0).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.errorMessage).toBeNull();
    expect(result.errorCode).toBeNull();
    expect(result.summary).toContain("will check the result when it finishes");
    expect(result.resultJson?.unmanagedBackgroundTask).toMatchObject({
      kind: "terminal_result_cleanup",
      stopped: true,
      stopReason: "unmanaged_background_task_stopped",
      terminalResultSeen: true,
      signal: "SIGTERM",
      exitCode: null,
      processSignal: "SIGTERM",
      liveBackgroundTaskIds: ["bbp6aknwz"],
    });
  });

  it("still reports a failed turn that the cleanup stopped as failed", async () => {
    const fixture = await fs.readFile(FIXTURE, "utf8");
    const failedTurn = fixture.replace('"subtype":"success","is_error":false', '"subtype":"error_during_execution","is_error":true');
    expect(failedTurn).not.toBe(fixture);

    const { result } = await runLingeringClaude(failedTurn);

    expect(result.signal).toBe("SIGTERM");
    expect(result.errorMessage).not.toBeNull();
  });

  it.each(["0", ""])("keeps background tasks disabled when config env sets %j", async (value) => {
    const { capture } = await runLingeringClaude(await fs.readFile(FIXTURE, "utf8"), {
      env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: value },
    });

    expect(capture.disableBackgroundTasks).toBe("1");
  });

  it.each([
    ["exits with its own code", "process.exit(23)", { exitCode: 23, signal: null }],
    ["dies from a different signal", 'process.kill(process.pid, "SIGABRT")', { exitCode: null, signal: "SIGABRT" }],
  ])("still reports a failure when the stopped CLI %s", async (_label, onSigterm, expected) => {
    const { result } = await runLingeringClaude(await fs.readFile(FIXTURE, "utf8"), { onSigterm });

    expect(result.exitCode).toBe(expected.exitCode);
    expect(result.signal).toBe(expected.signal);
    expect(result.resultJson?.unmanagedBackgroundTask).toMatchObject({
      signal: "SIGTERM",
      exitCode: expected.exitCode,
      processSignal: expected.signal,
    });
  });

  it("does not report a refused turn that the cleanup stopped as finished", async () => {
    const fixture = await fs.readFile(FIXTURE, "utf8");
    const refusedTurn = fixture.replace('"stop_reason":"end_turn"', '"stop_reason":"refusal"');
    expect(refusedTurn).not.toBe(fixture);

    const { result } = await runLingeringClaude(refusedTurn);

    expect(result.errorCode).toBe("claude_refusal");
    expect(result.signal).toBe("SIGTERM");
  });
});
