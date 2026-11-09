import { forbidden } from "../../errors.js";

type Connection = { config: Record<string, unknown>; transportConfig?: { sourceTemplateKey?: unknown } | null };

/** GitHub connection tools that merge a pull request directly. */
const DIRECT_MERGE_TOOLS = new Set(["merge-pull-request", "enable-pull-request-auto-merge", "enable-auto-merge"]);

function leafName(name: string) {
  return (name.split(/[.:/]/).pop() ?? name)
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
}

function isGitHubConnection(connection: Connection) {
  return connection.config.sourceTemplateKey === "github" || connection.transportConfig?.sourceTemplateKey === "github";
}

/**
 * Agents merge only through the protected-main gate (FAC-840 B), which
 * verifies base currency, exact-head CI, review coverage and red main first.
 */
export function assertGitHubDirectMergeAllowed(connection: Connection, toolName: string, session: { agentId: string | null }) {
  if (!session.agentId || !isGitHubConnection(connection) || !DIRECT_MERGE_TOOLS.has(leafName(toolName))) return;
  throw forbidden(
    "Direct pull request merges are disabled for agents. The coordinator merges through the protected-main gate: " +
    "POST /api/issues/<task-id>/merge-gate with {\"repo\":\"owner/name\",\"pullNumber\":N} (add \"dryRun\":true to see what is missing).",
    { code: "merge_gate_required" },
  );
}
