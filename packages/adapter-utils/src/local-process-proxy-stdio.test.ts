import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import { createNetworkProxyBridge } from "./local-process-sandbox.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function start(
  source: string,
  input = "",
  args: string[] = [],
  executable = process.execPath,
) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "paperclip-proxy-stdio-"),
  );
  roots.push(root);
  const bridge = path.join(root, "bridge.cjs");
  const worker = path.join(root, "worker.cjs");
  // Model the inherited descriptor state that caused synchronous native CLI
  // output to throw EAGAIN. This is a fixture, never a production workaround.
  await fs.writeFile(
    bridge,
    'const cp=require("node:child_process");const originalSpawn=cp.spawn;cp.spawn=(...args)=>{const child=originalSpawn(...args);process.stdout._handle.setBlocking(false);process.stderr._handle.setBlocking(false);return child;};\n' +
      (await createNetworkProxyBridge(0)),
  );
  await fs.writeFile(worker, source);
  const child = spawn(
    process.execPath,
    [bridge, path.join(root, "unused.sock"), executable, worker, ...args],
    {
      cwd: root,
      env: { ...process.env, PAPERCLIP_STDIO_TEST: "retained" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const firstData = once(child.stdout, "data");
  const out: Buffer[] = [],
    err: Buffer[] = [];
  child.stdout.on("data", (chunk) => out.push(chunk));
  child.stderr.on("data", (chunk) => err.push(chunk));
  child.stdin.end(input);
  const closed = once(child, "close").then(([code, signal]) => ({
    code,
    signal,
    out: Buffer.concat(out),
    err: Buffer.concat(err),
  }));
  return { child, closed, root, firstData };
}

it.runIf(process.platform === "linux")(
  "preserves large synchronous stdout/stderr despite a nonblocking bridge and slow consumer",
  async () => {
    const bytes = 2 * 1024 * 1024;
    const run = await start(
      `import os
for fd,c in [(1,65),(2,66)]:
 data=bytes([c])*${bytes}
 while data:
  n=os.write(fd,data)
  data=data[n:]
`,
      "",
      [],
      "/usr/bin/python3",
    );
    run.child.stdout.pause();
    run.child.stderr.pause();
    const timer = setTimeout(() => {
      run.child.stdout.resume();
      run.child.stderr.resume();
    }, 150);
    const result = await run.closed;
    clearTimeout(timer);
    expect(result.code).toBe(0);
    expect(result.signal).toBe(null);
    expect(result.out.equals(Buffer.alloc(bytes, 65))).toBe(true);
    expect(result.err.equals(Buffer.alloc(bytes, 66))).toBe(true);
  },
  15000,
);

it.runIf(process.platform === "linux")(
  "retains stdin, argv, cwd, environment and nonzero provider exit",
  async () => {
    const run = await start(
      `let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>data+=x);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({data,args:process.argv.slice(2),cwd:process.cwd(),env:process.env.PAPERCLIP_STDIO_TEST}));process.stderr.write('diagnostic');process.exitCode=7;});`,
      "native task input",
      ["literal space", "$literal"],
    );
    const result = await run.closed;
    expect(result.code).toBe(7);
    expect(result.err.toString()).toBe("diagnostic");
    expect(JSON.parse(result.out.toString())).toEqual({
      data: "native task input",
      args: ["literal space", "$literal"],
      cwd: run.root,
      env: "retained",
    });
  },
);

it.runIf(process.platform === "linux")(
  "forwards cancellation and preserves signal termination",
  async () => {
    const run = await start(
      `process.stdout.write('ready');setInterval(()=>{},1000);`,
    );
    await run.firstData;
    run.child.kill("SIGTERM");
    const result = await run.closed;
    expect(result.code).toBe(null);
    expect(result.signal).toBe("SIGTERM");
  },
  10000,
);
