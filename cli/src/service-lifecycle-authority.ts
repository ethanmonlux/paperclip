import { createDb, heartbeatRuns } from "@paperclipai/db";
import { count, eq } from "drizzle-orm";
import { resolveDefaultConfigPath, resolvePaperclipInstanceId } from "./config/home.js";
import { resolveConfigPath } from "./config/store.js";
import { resolveConnectionString } from "./commands/db-backup.js";
import { detectServiceManager } from "./services/service-manager.js";

/**
 * Service lifecycle authority: who may install, update, roll back, stop or
 * restart the Paperclip service, and when.
 *
 * - Never from inside an agent run. Agent runs share the service's Linux user,
 *   so the run environment is the only thing that tells them apart here. The
 *   run sandbox removes the systemd bus and install store from confined runs
 *   (see adapter-utils `service-lifecycle-guard`); this refusal covers any run
 *   that still reaches the CLI.
 * - Never while the active service has running agent runs. The server records
 *   every live run in its database; replacing the server under them is what
 *   breaks them. The managed upgrade watcher waits for a quiet instance before
 *   it acts, so it is never refused, and there is deliberately no override.
 */

export const AGENT_RUN_ENV_KEYS = ["PAPERCLIP_RUN_ID", "PAPERCLIP_AGENT_ID"] as const;

export class ServiceLifecycleRefusedError extends Error {
  constructor(message: string, readonly reason: "agent_run" | "runs_active") {
    super(message);
    this.name = "ServiceLifecycleRefusedError";
  }
}

export function assertServiceLifecycleOutsideAgentRun(action: string, env: NodeJS.ProcessEnv = process.env): void {
  const marker = AGENT_RUN_ENV_KEYS.find((key) => env[key]?.trim());
  if (!marker) return;
  throw new ServiceLifecycleRefusedError(
    `Refusing to ${action} from inside an agent run (${marker} is set). ` +
      "Paperclip installs and restarts belong to the instance operator's managed upgrade path, not to agent runs.",
    "agent_run",
  );
}

/** Running heartbeat runs recorded by the instance database; null when it cannot be read. */
export async function countRunningHeartbeatRuns(input: { configPath?: string; timeoutMs?: number } = {}): Promise<number | null> {
  const connection = resolveConnectionString(input.configPath ?? resolveConfigPath());
  const db = createDb(connection.value) as ReturnType<typeof createDb> & {
    $client?: { end?: (options?: { timeout?: number }) => Promise<void> };
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    const query = db.select({ value: count() }).from(heartbeatRuns).where(eq(heartbeatRuns.status, "running"))
      .then((rows) => Number(rows[0]?.value ?? 0));
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), input.timeoutMs ?? 5_000);
    });
    return await Promise.race([query, timeout]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    await db.$client?.end?.({ timeout: 1 }).catch(() => undefined);
  }
}

export type ActiveServiceRunsProbe = () => Promise<number>;

/**
 * Running agent runs of the active managed service. A service that is not
 * running has no live runs, so stale rows left by a crash never block the
 * restart that recovers it; an unreadable database likewise reads as zero.
 */
export async function countActiveServiceRuns(input: {
  instanceId?: string;
  detect?: typeof detectServiceManager;
  countRunning?: () => Promise<number | null>;
} = {}): Promise<number> {
  const instanceId = resolvePaperclipInstanceId(input.instanceId);
  const detection = await (input.detect ?? detectServiceManager)({ instanceId });
  if (!detection.supported) return 0;
  if (!(await detection.manager.status()).active) return 0;
  const countRunning = input.countRunning
    ?? (() => countRunningHeartbeatRuns({ configPath: input.instanceId ? resolveDefaultConfigPath(instanceId) : undefined }));
  return (await countRunning()) ?? 0;
}

export function describeActiveRuns(running: number): string {
  return `${running} agent run${running === 1 ? " is" : "s are"} running`;
}

export async function assertServiceLifecycleQuiet(
  action: string,
  activeRuns: ActiveServiceRunsProbe = () => countActiveServiceRuns(),
): Promise<void> {
  const running = await activeRuns();
  if (running <= 0) return;
  throw new ServiceLifecycleRefusedError(
    `Refusing to ${action} while ${describeActiveRuns(running)} on the active service. ` +
      "Retry when the instance is quiet; the managed upgrade watcher waits for that itself.",
    "runs_active",
  );
}
