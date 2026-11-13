import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { githubBrokerEnvironment, githubLauncherSource } from "./github-launcher.js";

const exec = promisify(execFile);
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe("candidate dispatch through the existing run-scoped GitHub launcher", () => {
  it("forwards an explicit dispatch with its expected SHA using only the current broker identity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-candidate-launcher-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const managed = path.join(root, "managed"), real = path.join(root, "real");
    await mkdir(managed); await mkdir(real);
    await writeFile(path.join(managed, "gh"), githubLauncherSource({ interpreterPath: process.execPath }), { mode: 0o700 });
    await writeFile(path.join(real, "gh"), `#!${process.execPath}\n
process.stdout.write(JSON.stringify({ args: process.argv.slice(2), managed: process.env.GH_TOKEN === "fixture-current-run" }));
if (process.env.GH_TOKEN !== "fixture-current-run") process.exitCode = 1;
`, { mode: 0o700 });
    let permitted = true;
    const requests: Array<{ path: string | undefined; authorization: string | undefined }> = [];
    const server = createServer((req, res) => {
      requests.push({ path: req.url, authorization: req.headers.authorization });
      res.writeHead(permitted ? 200 : 403, { "content-type": "application/json" });
      res.end(JSON.stringify(permitted ? { status: "available", env: { GH_TOKEN: "fixture-current-run" } } : {}));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const { port } = server.address() as { port: number };
    const env = { ...process.env, ...githubBrokerEnvironment({ GH_TOKEN: "ambient-must-not-be-used" },
      { url: `http://127.0.0.1:${port}`, token: "fixture-run-capability" }),
      GH_CONFIG_DIR: path.join(root, "config"), PATH: `${managed}:${real}:${process.env.PATH}` };
    const headSha = "a".repeat(40);
    const commands = [
      ["workflow", "run", "internal-windows.yml", "--repo", "ethanmonlux/facette", "--ref", "finished-candidate", "--field", `expected_sha=${headSha}`],
      ["api", "--method", "POST", "repos/ethanmonlux/facette/actions/workflows/internal-windows.yml/dispatches", "--header", "X-GitHub-Api-Version: 2026-03-10", "--field", "ref=finished-candidate", "--field", `inputs[expected_sha]=${headSha}`],
    ];
    for (const args of commands) {
      const result = await exec(path.join(managed, "gh"), args, { env });
      expect(JSON.parse(result.stdout)).toEqual({ args, managed: true });
      expect(result.stderr).not.toMatch(/ambient-must-not-be-used|fixture-current-run|fixture-run-capability/);
    }
    expect(requests).toEqual(commands.map(() => ({ path: "/runtime-tools/github/credentials", authorization: "Bearer fixture-run-capability" })));
    permitted = false;
    await expect(exec(path.join(managed, "gh"), commands[0]!, { env })).rejects.toMatchObject({
      code: 1, stdout: JSON.stringify({ args: commands[0], managed: false }), stderr: expect.stringContaining("capability_rejected"),
    });
  });
});
