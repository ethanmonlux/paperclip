import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Capture the provider stream before the shared process runner's 4 MiB tail
// limit. These files are private to the server's temp area and are kept only
// when a Claude invocation has no parseable terminal result.
const STREAM_LIMIT_BYTES = 8 * 1024 * 1024;

class StreamCapture {
  private readonly chunks: Buffer[] = [];
  private readonly hash = createHash("sha256");
  private retainedBytes = 0;
  totalBytes = 0;

  add(value: string) {
    const bytes = Buffer.from(value, "utf8");
    this.totalBytes += bytes.length;
    this.hash.update(bytes);
    if (this.retainedBytes >= STREAM_LIMIT_BYTES) return;
    const retained = bytes.subarray(0, STREAM_LIMIT_BYTES - this.retainedBytes);
    this.chunks.push(retained);
    this.retainedBytes += retained.length;
  }

  async save(file: string) {
    await fs.writeFile(file, Buffer.concat(this.chunks), { mode: 0o600, flag: "wx" });
    return {
      file: path.basename(file),
      totalBytes: this.totalBytes,
      retainedBytes: this.retainedBytes,
      truncated: this.totalBytes > this.retainedBytes,
      sha256: this.hash.digest("hex"),
    };
  }

  protocolSummary() {
    const retained = Buffer.concat(this.chunks).toString("utf8");
    const lines = retained.split(/\r?\n/);
    const finalLineComplete = retained.endsWith("\n");
    if (!finalLineComplete) lines.pop();
    let invalidCompleteLines = 0;
    let terminalResults = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as { type?: unknown };
        if (event?.type === "result") terminalResults += 1;
      } catch {
        invalidCompleteLines += 1;
      }
    }
    return { invalidCompleteLines, terminalResults, finalLineComplete };
  }
}

export function createClaudeRawOutputDiagnostic() {
  const stdout = new StreamCapture();
  const stderr = new StreamCapture();
  return {
    add(stream: "stdout" | "stderr", chunk: string) {
      (stream === "stdout" ? stdout : stderr).add(chunk);
    },
    async preserve(input: {
      runId: string;
      attempt: number;
      exitCode: number | null;
      signal: string | null;
      timedOut: boolean;
    }) {
      if (!/^[0-9a-f-]{36}$/i.test(input.runId) || !Number.isSafeInteger(input.attempt) || input.attempt < 1) return null;
      // A unique directory created by the server prevents an agent-writable
      // workspace entry from redirecting writes to another host file.
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), `paperclip-claude-parse-${input.runId}-${input.attempt}-`));
      const [out, err] = await Promise.all([
        stdout.save(path.join(directory, "stdout.raw")),
        stderr.save(path.join(directory, "stderr.raw")),
      ]);
      await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify({
        version: 1, runId: input.runId, attempt: input.attempt,
        exitCode: input.exitCode, signal: input.signal, timedOut: input.timedOut,
        stdout: out, stderr: err, stdoutProtocol: stdout.protocolSummary(),
      }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      return directory;
    },
  };
}
