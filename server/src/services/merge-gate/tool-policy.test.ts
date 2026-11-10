import { describe, expect, it } from "vitest";
import { assertGitHubDirectMergeAllowed } from "./tool-policy.js";

const github = { config: { sourceTemplateKey: "github" } };

describe("GitHub direct-merge tool policy", () => {
  it("refuses agent merges through the GitHub connection", () => {
    for (const name of ["merge-pull-request", "merge_pull_request", "github.mergePullRequest", "enable-pull-request-auto-merge"]) {
      expect(() => assertGitHubDirectMergeAllowed(github, name, { agentId: "agent-1" })).toThrow(/protected-main gate/);
    }
    expect(() => assertGitHubDirectMergeAllowed({ config: {}, transportConfig: { sourceTemplateKey: "github" } }, "merge-pull-request", { agentId: "agent-1" }))
      .toThrow(/protected-main gate/);
  });

  it("leaves other tools, other connections and non-agent sessions alone", () => {
    expect(() => assertGitHubDirectMergeAllowed(github, "pull-request-read", { agentId: "agent-1" })).not.toThrow();
    expect(() => assertGitHubDirectMergeAllowed(github, "update-pull-request-branch", { agentId: "agent-1" })).not.toThrow();
    expect(() => assertGitHubDirectMergeAllowed({ config: { sourceTemplateKey: "gitlab" } }, "merge-pull-request", { agentId: "agent-1" })).not.toThrow();
    expect(() => assertGitHubDirectMergeAllowed(github, "merge-pull-request", { agentId: null })).not.toThrow();
  });
});
