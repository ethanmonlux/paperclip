import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { startNetworkAllowlistProxy } from "./local-process-sandbox.js";

it.skipIf(process.platform === "win32").each([true, false])(
  "owns accepted proxy socket errors after CONNECT (allowed=%s)",
  async (allowed) => {
    const directory = await fs.mkdtemp(path.join("/tmp", "proxy-epipe-"));
    const socketPath = path.join(directory, "proxy.sock");
    const upstreamSockets = new Set<net.Socket>();
    const target = net.createServer((socket) => {
      upstreamSockets.add(socket);
      socket.on("error", () => socket.destroy());
      socket.on("close", () => upstreamSockets.delete(socket));
    });
    let server: http.Server | undefined;
    const createServer = http.createServer;
    const spy = vi.spyOn(http, "createServer").mockImplementation(
      ((...args: unknown[]) => {
        server = Reflect.apply(createServer, http, args);
        return server;
      }) as typeof http.createServer,
    );
    let proxy: Awaited<ReturnType<typeof startNetworkAllowlistProxy>> | undefined;
    let client: net.Socket | undefined;
    let accepted: net.Socket | undefined;
    try {
      target.listen(0, "127.0.0.1");
      await once(target, "listening");
      const port = (target.address() as net.AddressInfo).port;
      proxy = await startNetworkAllowlistProxy(
        [allowed ? "127.0.0.1:" + port : "example.invalid"], [], socketPath,
      );
      const connected = new Promise<net.Socket>((resolve) => {
        server!.once("connect", (_request, socket) => resolve(socket as net.Socket));
      });
      client = net.connect(socketPath);
      client.on("error", () => client?.destroy());
      const response = once(client, "data");
      client.write("CONNECT 127.0.0.1:" + port + " HTTP/1.1\r\nHost: localhost\r\n\r\n");
      accepted = await connected;
      const [data] = await response;
      expect(data.toString()).toContain(allowed ? "200 Connection Established" : "403 Forbidden");
      // A peer can close while a pipe is writing. The accepted socket must have
      // a lifecycle owner even after HTTP detaches it for a CONNECT tunnel.
      expect(() => accepted!.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))).not.toThrow();
      expect(accepted.destroyed).toBe(true);
    } finally {
      client?.destroy();
      accepted?.destroy();
      for (const socket of upstreamSockets) socket.destroy();
      await proxy?.close();
      await new Promise<void>((resolve) => target.close(() => resolve()));
      spy.mockRestore();
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
  5000,
);
