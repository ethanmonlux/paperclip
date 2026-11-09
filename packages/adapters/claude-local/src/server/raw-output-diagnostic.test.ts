import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createClaudeRawOutputDiagnostic } from "./raw-output-diagnostic.js";

describe("Claude raw parse diagnostics", () => {
  it("preserves both streams and records signal and truncation without changing parser output", async () => {
    let saved: string | null = null;
    try {
      const capture = createClaudeRawOutputDiagnostic();
      capture.add("stdout", '{"type":"system","subtype":"init"}\n');
      capture.add("stdout", "x".repeat(8 * 1024 * 1024));
      capture.add("stderr", "provider warning\n");
      const directory = await capture.preserve({
        runId: "00000000-0000-4000-8000-000000000001", attempt: 1,
        exitCode: null, signal: "SIGTERM", timedOut: false });
      saved = directory;
      expect(directory).not.toBeNull();
      const manifest = JSON.parse(await readFile(path.join(directory!, "manifest.json"), "utf8"));
      expect(manifest).toMatchObject({ signal: "SIGTERM", stdout: { truncated: true }, stderr: { truncated: false } });
      expect((await readFile(path.join(directory!, "stdout.raw"))).length).toBe(8 * 1024 * 1024);
      expect(await readFile(path.join(directory!, "stderr.raw"), "utf8")).toBe("provider warning\n");
      if (process.platform !== "win32") expect((await stat(directory!)).mode & 0o777).toBe(0o700);
    } finally {
      if (saved) await rm(saved, { recursive: true, force: true });
    }
  });

  it("does not follow a diagnostic symlink planted in the agent workspace", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "claude-agent-workspace-"));
    const target = path.join(workspace, "outside.txt");
    let saved: string | null = null;
    try {
      await writeFile(target, "untouched");
      const planted = path.join(workspace, ".paperclip", "claude-parse-diagnostics", "00000000-0000-4000-8000-000000000002", "1");
      await mkdir(planted, { recursive: true });
      await symlink(target, path.join(planted, "manifest.json"));
      const capture = createClaudeRawOutputDiagnostic();
      capture.add("stdout", "bad-json\n");
      saved = await capture.preserve({ runId: "00000000-0000-4000-8000-000000000002", attempt: 1,
        exitCode: 1, signal: null, timedOut: false });
      expect(saved).not.toContain(workspace);
      expect(await readFile(target, "utf8")).toBe("untouched");
      expect(JSON.parse(await readFile(path.join(saved!, "manifest.json"), "utf8"))).toMatchObject({ runId: "00000000-0000-4000-8000-000000000002" });
    } finally {
      if (saved) await rm(saved, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
