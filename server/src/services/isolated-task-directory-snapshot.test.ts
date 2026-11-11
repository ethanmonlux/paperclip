import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectTaskDirectory,
  materializeTaskDirectorySnapshot,
  TASK_DIRECTORY_SNAPSHOT_SCHEMA,
  taskDirectoryManifestDigest,
  type TaskDirectorySnapshotManifest,
} from "./isolated-task-directory-snapshot.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("task directory snapshot restore", () => {
  it("restores a valid saved nested Git checkout while cleanup inspection still refuses it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-legacy-task-snapshot-"));
    roots.push(root);
    const source = Buffer.from("unpublished source\n");
    const gitHead = Buffer.from("ref: refs/heads/main\n");
    const manifest: TaskDirectorySnapshotManifest = {
      schema: TASK_DIRECTORY_SNAPSHOT_SCHEMA,
      excluded: [],
      entries: [
        { path: "repo", type: "directory", mode: 0o700 },
        { path: "repo/.git", type: "directory", mode: 0o700 },
        { path: "repo/.git/HEAD", type: "file", mode: 0o600, size: gitHead.length,
          sha256: createHash("sha256").update(gitHead).digest("hex") },
        { path: "repo/source.txt", type: "file", mode: 0o600, size: source.length,
          sha256: createHash("sha256").update(source).digest("hex") },
      ],
    };
    const encoded = Buffer.from(JSON.stringify(manifest));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(encoded.length);
    const payload = Buffer.concat([Buffer.from("PCTD-PLAIN1\n"), length, encoded, gitHead, source]);
    const digest = taskDirectoryManifestDigest(manifest);
    const staging = await materializeTaskDirectorySnapshot({ payload, target: path.join(root, "task"), expectedDigest: digest });

    expect(await fs.readFile(path.join(staging, "repo/source.txt"), "utf8")).toBe("unpublished source\n");
    expect((await inspectTaskDirectory(staging, { restoreVerification: true })).digest).toBe(digest);
    await expect(inspectTaskDirectory(staging)).rejects.toThrow("nested_git_repository");
  });
});
