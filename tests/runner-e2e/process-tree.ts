import { spawn, type ChildProcess } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface ProcessObservation {
  pid: number;
  parentPid: number;
  processGroupId: number;
  started: string;
  kind: string;
  state?: string;
}

export interface ObservedProcessGroup {
  processGroupId: number;
  depth: number;
  members: Array<Pick<ProcessObservation, "pid" | "started">>;
}

export interface ObservedProcessTreeMember {
  process: ProcessObservation;
  depth: number;
}

export function observeDescendantProcessTree(
  table: readonly ProcessObservation[],
  rootPid: number,
) {
  const byPid = new Map(table.map((candidate) => [candidate.pid, candidate]));
  const byParent = new Map<number, ProcessObservation[]>();
  for (const candidate of table) {
    const children = byParent.get(candidate.parentPid) ?? [];
    children.push(candidate);
    byParent.set(candidate.parentPid, children);
  }
  const observed = new Map<number, ObservedProcessTreeMember>();
  const pending = [{ pid: rootPid, depth: 0 }];
  while (pending.length > 0) {
    const next = pending.shift()!;
    if (observed.has(next.pid)) continue;
    const candidate = byPid.get(next.pid);
    if (!candidate) continue;
    observed.set(next.pid, { process: candidate, depth: next.depth });
    for (const child of byParent.get(next.pid) ?? []) {
      pending.push({ pid: child.pid, depth: next.depth + 1 });
    }
  }
  const groupsById = new Map<number, ObservedProcessGroup>();
  for (const { process: candidate, depth } of observed.values()) {
    const group = groupsById.get(candidate.processGroupId) ?? {
      processGroupId: candidate.processGroupId,
      depth,
      members: [],
    };
    group.depth = Math.max(group.depth, depth);
    group.members.push({ pid: candidate.pid, started: candidate.started });
    groupsById.set(candidate.processGroupId, group);
  }
  return {
    members: [...observed.values()].sort(
      (left, right) => left.depth - right.depth,
    ),
    groups: [...groupsById.values()].sort(
      (left, right) => right.depth - left.depth,
    ),
  };
}

export function safeProcessGroupTerminationOrder(input: {
  rootProcessGroupId: number;
  currentProcessGroupId: number | null;
  groups: readonly ObservedProcessGroup[];
}) {
  if (input.currentProcessGroupId === null) return [];
  const safe = new Map<number, number>();
  for (const group of input.groups) {
    if (
      group.processGroupId <= 1 ||
      group.processGroupId === input.currentProcessGroupId
    ) {
      continue;
    }
    safe.set(
      group.processGroupId,
      Math.max(safe.get(group.processGroupId) ?? -1, group.depth),
    );
  }
  if (
    input.rootProcessGroupId > 1 &&
    input.rootProcessGroupId !== input.currentProcessGroupId &&
    input.groups.some(
      (group) => group.processGroupId === input.rootProcessGroupId,
    )
  ) {
    safe.set(input.rootProcessGroupId, -1);
  }
  return [...safe.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([processGroupId]) => processGroupId);
}

export function revalidateObservedProcessGroups(
  groups: readonly ObservedProcessGroup[],
  table: readonly ProcessObservation[],
) {
  const byPid = new Map(table.map((candidate) => [candidate.pid, candidate]));
  return groups.filter((group) =>
    group.members.some((member) => {
      const candidate = byPid.get(member.pid);
      return (
        candidate?.processGroupId === group.processGroupId &&
        candidate.started === member.started
      );
    }),
  );
}

/**
 * Refresh groups only after their original members have been revalidated.
 * A process may replace itself or fork a final cleanup helper after SIGTERM.
 * Retain that continuously live group until one poll observes it as empty.
 */
export function refreshContinuouslyLiveProcessGroups(
  groups: readonly ObservedProcessGroup[],
  table: readonly ProcessObservation[],
) {
  const membersByGroup = new Map<number, ProcessObservation[]>();
  for (const candidate of table) {
    const members = membersByGroup.get(candidate.processGroupId) ?? [];
    members.push(candidate);
    membersByGroup.set(candidate.processGroupId, members);
  }
  return groups.flatMap((group) => {
    const members = membersByGroup.get(group.processGroupId);
    return members
      ? [
          {
            ...group,
            members: members.map((candidate) => ({
              pid: candidate.pid,
              started: candidate.started,
            })),
          },
        ]
      : [];
  });
}

const diagnosticProcessKinds = new Set([
  "bash",
  "chrome",
  "codex",
  "google-chrome",
  "node",
  "paperclip-runnerd",
  "playwright",
  "pnpm",
  "postgres",
  "sh",
  "tsx",
]);

export function diagnosticProcessKind(command: string, platform: NodeJS.Platform = process.platform) {
  const name = path.basename(command);
  // Linux comm is limited to 15 bytes. This is a diagnostic role only;
  // preservation still requires the trusted run PID/start/group and ancestry.
  if (platform === "linux" && name === "paperclip-runne") return "paperclip-runnerd";
  return diagnosticProcessKinds.has(name) ? name : "other";
}

const auxvClockTickType = 17n; // AT_CLKTCK, the value sysconf(_SC_CLK_TCK) returns.
let linuxClockTicks: Promise<number | null> | undefined;
function readLinuxClockTicks() {
  linuxClockTicks ??= readFile("/proc/self/auxv").then(auxv => {
    // auxv is native-endian (type, value) word pairs; only 64-bit words are read here.
    const read = os.endianness() === "LE" ? "readBigUInt64LE" : "readBigUInt64BE";
    for (let offset = 0; offset + 16 <= auxv.length; offset += 16) {
      const type = auxv[read](offset);
      if (type === 0n) break;
      if (type === auxvClockTickType) {
        const ticks = Number(auxv[read](offset + 8));
        return Number.isSafeInteger(ticks) && ticks > 0 ? ticks : null;
      }
    }
    return null;
  }, () => null);
  return linuxClockTicks;
}

const lstartDays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const lstartMonths = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** ps lstart is ctime(boot time + whole seconds since boot) in local time. */
function formatProcessStart(seconds: bigint) {
  const date = new Date(Number(seconds) * 1000);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${lstartDays[date.getDay()]} ${lstartMonths[date.getMonth()]} ${String(date.getDate()).padStart(2, " ")} `
    + `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())} ${date.getFullYear()}`;
}

/**
 * Read the same fields ps reports straight from /proc, so inspection starts
 * no child process. A spawned inspector is in the caller's process group from
 * fork() until its own setsid(). A group signal in that window stays pending in
 * the inspector, which then dies before exec. Cleanup audits run exactly when
 * a launcher signals the caller's group, so a forked inspector turned that
 * signal into a failed audit. Only an exited process is skipped; any other read
 * or parse failure fails the whole inspection.
 */
async function readLinuxProcessTable(): Promise<ProcessObservation[] | null> {
  try {
    const ticks = await readLinuxClockTicks();
    const bootSeconds = /^btime (\d+)$/m.exec(await readFile("/proc/stat", "utf8"))?.[1];
    if (!ticks || !bootSeconds) return null;
    const pids = (await readdir("/proc")).filter(name => /^\d+$/.test(name));
    const rows = await Promise.all(pids.map(async (pid): Promise<ProcessObservation | undefined> => {
      let stat: string;
      try { stat = await readFile(`/proc/${pid}/stat`, "utf8"); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ESRCH") return undefined;
        throw error;
      }
      // comm can contain spaces and parentheses. Fields after its final ')'
      // start at field 3 (state); field 22 (starttime) is index 19.
      const end = stat.lastIndexOf(") ");
      const fields = end >= 0 ? stat.slice(end + 2).trim().split(/\s+/) : [];
      const [state, parentPid, processGroupId] = fields;
      const startTicks = fields[19];
      if (!stat.startsWith(`${pid} (`) || !state || ![parentPid, processGroupId, startTicks].every(value => /^\d+$/.test(value ?? ""))) {
        throw new Error(`Invalid /proc/${pid}/stat`);
      }
      return {
        pid: Number(pid),
        parentPid: Number(parentPid),
        processGroupId: Number(processGroupId),
        started: formatProcessStart(BigInt(bootSeconds) + BigInt(startTicks!) / BigInt(ticks)),
        // A fixed category, never the target-chosen name; see readProcessTable.
        kind: diagnosticProcessKind(stat.slice(stat.indexOf("(") + 1, end)),
        state,
      };
    }));
    return rows.filter((row): row is ProcessObservation => row !== undefined);
  } catch {
    return null;
  }
}

const linuxWordSize64 = new Set(["arm64", "loong64", "mips64el", "ppc64", "riscv64", "s390x", "x64"]);

export async function readProcessTable(startInspector?: () => ChildProcess): Promise<ProcessObservation[] | null> {
  if (process.platform === "win32") {
    return null;
  }
  if (!startInspector && process.platform === "linux" && linuxWordSize64.has(process.arch)) {
    return await readLinuxProcessTable();
  }
  // Elsewhere ps is the inspector. Its fork-to-setsid window remains, so a
  // group signal can still interrupt one inspection there.
  return await new Promise<ProcessObservation[] | null>((resolve) => {
    const inspector = startInspector ? startInspector() : spawn(
      "ps",
      ["-e", "-o", "pid=,ppid=,pgid=,lstart=,stat=,comm="],
      {
        env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
        stdio: ["ignore", "pipe", "ignore"],
        // A wrapper-group shutdown must not interrupt its own bounded audit.
        detached: true,
      },
    );
    let output = "";
    let settled = false;
    let truncated = false;
    const finish = (value: ProcessObservation[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(inspectionTimeout);
      resolve(value);
    };
    const inspectionTimeout = setTimeout(() => {
      inspector.kill("SIGKILL");
      finish(null);
    }, 5_000);
    inspectionTimeout.unref();
    inspector.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      if (output.length + chunk.length > 1024 * 1024) {
        truncated = true;
        inspector.kill("SIGKILL");
        finish(null);
        return;
      }
      output += chunk;
    });
    inspector.once("error", () => finish(null));
    inspector.once("close", (code) => {
      if (code !== 0 || truncated) { finish(null); return; }
      const observations = output
        .split(/\r?\n/)
        .map((line) =>
          /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s+(.+?)\s*$/.exec(
            line,
          ),
        )
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match): ProcessObservation => {
          // A target process can choose its own argv and process name. Emit a
          // fixed category instead of target-controlled text so diagnostics
          // can never turn that metadata into a secret-exfiltration channel.
          const kind = diagnosticProcessKind(match[6]!);
          return {
            pid: Number(match[1]),
            parentPid: Number(match[2]),
            processGroupId: Number(match[3]),
            started: match[4]!,
            kind,
            state: match[5]!,
          };
        });
      finish(observations);
    });
  }).catch(() => null);
}
