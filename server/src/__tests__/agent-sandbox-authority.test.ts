import { describe, expect, it } from "vitest";
import { listAgentSandboxWidening } from "../services/agent-sandbox-authority.js";

describe("listAgentSandboxWidening", () => {
  const sandboxed = {
    filesystemScope: "workspace",
    networkScope: "allowlist",
    networkAllowlist: ["api.anthropic.com"],
    filesystemExtraPaths: ["/opt/tools", { path: "/srv/cache", access: "rw" }],
  };

  it("reports nothing for an unchanged or tightened sandbox", () => {
    expect(listAgentSandboxWidening(sandboxed, sandboxed)).toEqual([]);
    expect(listAgentSandboxWidening(sandboxed, {
      ...sandboxed,
      networkScope: "deny",
      networkAllowlist: [],
      filesystemExtraPaths: [{ path: "/srv/cache", access: "ro" }],
    })).toEqual([]);
    expect(listAgentSandboxWidening(sandboxed, { ...sandboxed, networkAllowlist: [" API.anthropic.com "] })).toEqual([]);
    expect(listAgentSandboxWidening(sandboxed, { ...sandboxed, filesystemExtraPaths: ["/opt/tools/"] })).toEqual([]);
  });

  it("reports each widened setting", () => {
    expect(listAgentSandboxWidening(sandboxed, {})).toEqual(["filesystemScope", "networkScope"]);
    expect(listAgentSandboxWidening({ ...sandboxed, networkScope: "deny" }, sandboxed)).toEqual(["networkScope"]);
    expect(listAgentSandboxWidening(sandboxed, { ...sandboxed, filesystemExtraPaths: ["/opt/tools", "/run/user/1000"] }))
      .toEqual(["filesystemExtraPaths"]);
    expect(listAgentSandboxWidening(sandboxed, { ...sandboxed, filesystemExtraPaths: [{ path: "/opt/tools", access: "rw" }] }))
      .toEqual(["filesystemExtraPaths"]);
    expect(listAgentSandboxWidening(sandboxed, { ...sandboxed, networkAllowlist: ["api.anthropic.com", "127.0.0.1:3100"] }))
      .toEqual(["networkAllowlist"]);
  });

  it("treats an unsandboxed agent's added mounts and targets as widening", () => {
    expect(listAgentSandboxWidening({}, { filesystemExtraPaths: ["/home"] })).toEqual(["filesystemExtraPaths"]);
    expect(listAgentSandboxWidening(null, { model: "x" })).toEqual([]);
  });
});
