/**
 * Urgent lane (FAC-840 B).
 *
 * A `critical` issue (an explicit critical task, or the merge gate's red-main
 * owner issue) runs ahead of every other queued run for its agent, whatever
 * the issue's status. When the agent has no free slot, the dispatcher may
 * start that one run as a temporary burst: the agent's effective
 * `maxConcurrentRuns` is one higher for that run only. Nothing in the agent's
 * configuration changes, so the burst reverts by itself when the run ends,
 * even after a crash. A burst needs free memory for a full run cap plus
 * headroom; otherwise the urgent run parks at the front of the queue and
 * takes the next free slot. Every burst, park and revert is logged on the
 * urgent issue.
 */
import { readFileSync } from "node:fs";
import { freemem } from "node:os";

const GIB = 1024 ** 3;
/** Memory cap of one agent run. */
export const URGENT_BURST_RUN_MEMORY_BYTES = 4 * GIB;
/** Free memory that must remain after a burst run takes its cap. */
export const URGENT_BURST_HEADROOM_BYTES = 1 * GIB;
/** At most this many burst runs per agent at once. */
export const URGENT_BURST_MAX_EXTRA_RUNS = 1;

export function isUrgentIssuePriority(priority: string | null | undefined) {
  return priority === "critical";
}

/**
 * Available memory as the kernel reports it. `MemAvailable` counts
 * reclaimable cache; `os.freemem()` is the fallback where /proc is absent.
 */
export function readAvailableMemoryBytes(readMeminfo: () => string = () => readFileSync("/proc/meminfo", "utf8")): number {
  try {
    const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(readMeminfo());
    if (match) return Number(match[1]) * 1024;
  } catch {
    // Not Linux, or /proc is unreadable: fall through.
  }
  return freemem();
}

export type UrgentBurstDecision =
  | { grant: true; effectiveMaxConcurrentRuns: number; availableMemoryBytes: number }
  | { grant: false; reason: "not_urgent" | "slot_available" | "burst_in_use" | "insufficient_memory"; availableMemoryBytes: number };

export function decideUrgentBurst(input: {
  issuePriority: string | null | undefined;
  maxConcurrentRuns: number;
  runningCount: number;
  runningBurstCount: number;
  availableMemoryBytes: number;
}): UrgentBurstDecision {
  const { availableMemoryBytes } = input;
  if (!isUrgentIssuePriority(input.issuePriority)) return { grant: false, reason: "not_urgent", availableMemoryBytes };
  if (input.runningCount < input.maxConcurrentRuns) return { grant: false, reason: "slot_available", availableMemoryBytes };
  if (input.runningBurstCount >= URGENT_BURST_MAX_EXTRA_RUNS ||
    input.runningCount >= input.maxConcurrentRuns + URGENT_BURST_MAX_EXTRA_RUNS) {
    return { grant: false, reason: "burst_in_use", availableMemoryBytes };
  }
  if (availableMemoryBytes < URGENT_BURST_RUN_MEMORY_BYTES + URGENT_BURST_HEADROOM_BYTES) {
    return { grant: false, reason: "insufficient_memory", availableMemoryBytes };
  }
  return { grant: true, effectiveMaxConcurrentRuns: input.maxConcurrentRuns + 1, availableMemoryBytes };
}

/** Recorded on the burst run's context snapshot. */
export interface UrgentBurstRecord {
  grantedAt: string;
  baseMaxConcurrentRuns: number;
  effectiveMaxConcurrentRuns: number;
  availableMemoryBytes: number;
  revertedAt?: string;
}

export function formatGiB(bytes: number) {
  return `${(bytes / GIB).toFixed(1)} GiB`;
}

/**
 * Queue order: dependency-ready urgent issues first, then the existing
 * order (in-progress, other ready issues, issue-less runs, blocked issues),
 * then priority, then age. Returns the rank tuple compared left to right.
 */
export function queuedRunRank(input: {
  hasIssue: boolean;
  dependencyReady: boolean;
  issueStatus: string | null | undefined;
  issuePriority: string | null | undefined;
}): [number, number] {
  const urgentReady = input.hasIssue && input.dependencyReady && isUrgentIssuePriority(input.issuePriority);
  const statusRank = urgentReady ? -1
    : input.hasIssue ? (input.dependencyReady ? (input.issueStatus === "in_progress" ? 0 : 1) : 3)
    : 2;
  return [statusRank, issuePriorityRank(input.issuePriority)];
}

export function issuePriorityRank(priority: string | null | undefined) {
  switch (priority) {
    case "critical": return 0;
    case "high": return 1;
    case "medium": return 2;
    case "low": return 3;
    default: return 4;
  }
}
