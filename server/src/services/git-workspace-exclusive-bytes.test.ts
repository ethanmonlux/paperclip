import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exclusiveAllocatedBytes } from "./git-workspace-expiration.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("exclusive allocated bytes", () => {
  it("counts internal hardlinks once and excludes blocks still linked outside the removal scope", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-exclusive-bytes-"));
    roots.push(root);
    const candidate = path.join(root, "candidate");
    await fs.mkdir(candidate);
    const internal = path.join(candidate, "internal");
    const external = path.join(candidate, "external");
    await fs.writeFile(internal, Buffer.alloc(8192, 1));
    await fs.link(internal, path.join(candidate, "internal-copy"));
    await fs.writeFile(external, Buffer.alloc(8192, 2));
    await fs.link(external, path.join(root, "outside-link"));

    const directoryBytes = (await fs.lstat(candidate)).blocks * 512;
    const internalBytes = (await fs.lstat(internal)).blocks * 512;
    expect(await exclusiveAllocatedBytes(candidate, () => true)).toBe(directoryBytes + internalBytes);

    await fs.rm(path.join(root, "outside-link"));
    const externalBytes = (await fs.lstat(external)).blocks * 512;
    expect(await exclusiveAllocatedBytes(candidate, () => true)).toBe(directoryBytes + internalBytes + externalBytes);
  });
});
