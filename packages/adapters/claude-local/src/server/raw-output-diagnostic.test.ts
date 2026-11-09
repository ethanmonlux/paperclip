import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createClaudeRawOutputDiagnostic } from "./raw-output-diagnostic.js";

describe("Claude raw parse diagnostics", () => {
  it("preserves both streams and records signal and truncation without changing parser output", async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "claude-diagnostic-"));
    try {
      const capture = createClaudeRawOutputDiagnostic();
      capture.add("stdout", '{"type":"system","subtype":"init"}\n');
      capture.add("stdout", "x".repeat(8 * 1024 * 1024));
      capture.add("stderr", "provider warning\n");
      const directory = await capture.preserve({ directory: scratch,
        runId: "00000000-0000-4000-8000-000000000001", attempt: 1,
        exitCode: null, signal: "SIGTERM", timedOut: false });
      expect(directory).not.toBeNull();
      const manifest = JSON.parse(await readFile(path.join(directory!, "manifest.json"), "utf8"));
      expect(manifest).toMatchObject({ signal: "SIGTERM", stdout: { truncated: true }, stderr: { truncated: false } });
      expect((await readFile(path.join(directory!, "stdout.raw"))).length).toBe(8 * 1024 * 1024);
      expect(await readFile(path.join(directory!, "stderr.raw"), "utf8")).toBe("provider warning\n");
      if (process.platform !== "win32") expect((await stat(directory!)).mode & 0o777).toBe(0o700);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
