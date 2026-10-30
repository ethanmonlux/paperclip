import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import {
  buildLocalProcessSandboxSpawnTarget,
  createNetworkProxyBridge,
} from "./local-process-sandbox.js";

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

it
  .runIf(
    process.platform === "linux" && Boolean(process.env.PAPERCLIP_TEST_BWRAP),
  )
  .each([false, true])(
  "ends the sandbox and its pipe-holding descendants after provider exit (cancel=%s)",
  async (cancel) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "paperclip-proxy-descendant-"),
    );
    roots.push(root);
    const heartbeat = path.join(root, "heartbeat");
    const worker = path.join(root, "worker.cjs");
    const daemon = `
      const fs = require("node:fs");
      const beat = () => fs.appendFileSync(${JSON.stringify(heartbeat)}, "alive");
      beat();
      setInterval(beat, 50);
      process.send("ready");
      process.disconnect();
      ${cancel ? 'setTimeout(() => process.kill(Number(process.argv[1]), "SIGTERM"), 200);' : ""}
    `;
    await fs.writeFile(
      worker,
      `
      const {spawn} = require("node:child_process");
      const daemon = spawn(process.execPath, ["-e", ${JSON.stringify(daemon)}, String(process.ppid)],
        {stdio: ["ignore", "inherit", "inherit", "ipc"]});
      daemon.on("message", () => {
        process.stdout.write("provider-exited");
        process.exit(0);
      });
    `,
    );
    const target = await buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: [worker],
      cwd: root,
      options: {
        workspaceDir: root,
        filesystemScope: "workspace",
        networkScope: "allowlist",
        networkAllowlist: ["example.invalid"],
        command: process.env.PAPERCLIP_TEST_BWRAP,
      },
    });
    const child = spawn(target.command, target.args, {
      cwd: target.cwd,
      env: { ...process.env, ...target.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output: Buffer[] = [],
      errors: Buffer[] = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    const closed = once(child, "close");
    const guard = setTimeout(() => child.kill("SIGKILL"), 10000);
    try {
      const [code, signal] = await closed;
      expect(
        Buffer.concat(output).toString(),
        Buffer.concat(errors).toString(),
      ).toContain("provider-exited");
      if (cancel) expect(signal === "SIGTERM" || code === 143).toBe(true);
      else expect(code, Buffer.concat(errors).toString()).toBe(0);
      const stopped = await fs.readFile(heartbeat, "utf8");
      expect(stopped.length).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await fs.readFile(heartbeat, "utf8")).toBe(stopped);
    } finally {
      clearTimeout(guard);
      child.kill("SIGKILL");
      await target.cleanup?.();
    }
  },
  15000,
);
