/**
 * Staple Console capability map (FAC-620 v2, Level 2 and Level 4).
 *
 * The registry is a versioned issue document (key `capability-map`, on STA-152) that the
 * coordinators keep current. Each claim names the capability as it works when solved and links
 * the tasks and PRs behind it. This module parses that document and derives each claim's color
 * from the linked tasks. It is pure; the board builder supplies the lookups.
 *
 * Colors (founder, 2026-11-09 14:22 MT):
 * - green, works now: a merged PR, plus recorded acceptance where the claim needs it;
 * - blue, being fixed or built: a real gap with someone actively on it;
 * - red, needs attention: a real gap nothing is fixing (no owner, the fixing task is stuck,
 *   or it waits on Ethan).
 * Green always needs proof: a stated green override without it renders blue.
 */

import type {
  StapleConsoleCiState,
  StapleConsolePrState,
  StapleConsolePullRequestInput,
  StapleConsoleReviewOutcome,
} from "./staple-console.js";

export const STAPLE_CONSOLE_CAPABILITY_MAP_KEY = "capability-map";
/** The task that owns the registry. A same-key document on any other task never replaces it. */
export const STAPLE_CONSOLE_CAPABILITY_MAP_OWNER = "STA-152";

export type StapleConsoleClaimState = "green" | "blue" | "red";

export const STAPLE_CONSOLE_CLAIM_STATE_LABELS: Record<StapleConsoleClaimState, string> = {
  green: "Works now",
  blue: "Being built",
  red: "Needs attention",
};

// ---------------------------------------------------------------------------
// Document shape (the JSON inside the `capability-map` document)

export interface StapleConsoleCapabilityMapClaim {
  /** The capability as it works when solved, e.g. "Tasks wake when their blocker lands". */
  text: string;
  /** One plain sentence: what went wrong or was missing, and what Ethan gets when it is green. */
  why: string;
  /** Tasks that build or fix it (identifiers, e.g. "STA-185"). */
  issues?: string[];
  /** Tasks that record a known defect against it. An open one is a real gap. */
  defects?: string[];
  /** Extra PRs that prove it, as "owner/repo#N" or a GitHub PR URL. */
  prs?: string[];
  /** The claim needs recorded acceptance (founder or visual) before it can be green. */
  needsAcceptance?: boolean;
  /** Recorded acceptance: links to the evidence, and when it passed. */
  acceptance?: { evidence?: string[]; at?: string | null; note?: string | null } | null;
  /** A stated color with its reason. Green still needs proof. */
  override?: { state: StapleConsoleClaimState; reason: string } | null;
}

export interface StapleConsoleCapabilityMapCapability {
  key: string;
  title: string;
  claims: StapleConsoleCapabilityMapClaim[];
}

export interface StapleConsoleCapabilityMapGroup {
  key: string;
  label: string;
  capabilities: StapleConsoleCapabilityMapCapability[];
}

export interface StapleConsoleCapabilityMap {
  version: number;
  groups: StapleConsoleCapabilityMapGroup[];
  /** Plain feature names for cards, by task identifier ("STA-214": "Console v2 layout"). */
  names?: Record<string, string>;
}

export interface StapleConsoleCapabilityMapDocumentInput {
  issueIdentifier: string;
  revisionNumber: number;
  updatedAt: string;
  body: string;
}

export type StapleConsoleCapabilityMapParse =
  | { ok: true; map: StapleConsoleCapabilityMap }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim()) : [];
}

const CLAIM_STATES = new Set<StapleConsoleClaimState>(["green", "blue", "red"]);

/**
 * Read the map from the document body: the first fenced ```json block, or the whole body
 * when it is bare JSON. Malformed entries are dropped one by one, so a single bad claim does
 * not blank the board; a body with no usable groups is an error.
 */
export function parseStapleConsoleCapabilityMap(body: string): StapleConsoleCapabilityMapParse {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(body)?.[1];
  let raw: unknown;
  try {
    raw = JSON.parse(fenced ?? body);
  } catch {
    return { ok: false, error: "The capability-map document has no readable JSON block" };
  }
  if (!isRecord(raw) || !Array.isArray(raw.groups)) {
    return { ok: false, error: "The capability-map JSON has no groups list" };
  }
  const groups: StapleConsoleCapabilityMapGroup[] = [];
  for (const group of raw.groups) {
    if (!isRecord(group) || typeof group.label !== "string" || !Array.isArray(group.capabilities)) continue;
    const capabilities: StapleConsoleCapabilityMapCapability[] = [];
    for (const capability of group.capabilities) {
      if (!isRecord(capability) || typeof capability.title !== "string" || !Array.isArray(capability.claims)) continue;
      const claims: StapleConsoleCapabilityMapClaim[] = [];
      for (const claim of capability.claims) {
        if (!isRecord(claim) || typeof claim.text !== "string" || !claim.text.trim()) continue;
        const override = isRecord(claim.override)
          && CLAIM_STATES.has(claim.override.state as StapleConsoleClaimState)
          && typeof claim.override.reason === "string" && claim.override.reason.trim()
          ? { state: claim.override.state as StapleConsoleClaimState, reason: claim.override.reason.trim() }
          : null;
        const acceptance = isRecord(claim.acceptance)
          ? {
            evidence: stringList(claim.acceptance.evidence),
            at: typeof claim.acceptance.at === "string" ? claim.acceptance.at : null,
            note: typeof claim.acceptance.note === "string" ? claim.acceptance.note : null,
          }
          : null;
        claims.push({
          text: claim.text.trim(),
          why: typeof claim.why === "string" ? claim.why.trim() : "",
          issues: stringList(claim.issues),
          defects: stringList(claim.defects),
          prs: stringList(claim.prs),
          needsAcceptance: claim.needsAcceptance === true,
          acceptance,
          override,
        });
      }
      capabilities.push({
        key: typeof capability.key === "string" && capability.key ? capability.key : capability.title,
        title: capability.title.trim(),
        claims,
      });
    }
    groups.push({ key: typeof group.key === "string" && group.key ? group.key : group.label, label: group.label.trim(), capabilities });
  }
  if (groups.length === 0) return { ok: false, error: "The capability-map JSON has no usable groups" };
  const names: Record<string, string> = {};
  if (isRecord(raw.names)) {
    for (const [identifier, name] of Object.entries(raw.names)) {
      if (typeof name === "string" && name.trim()) names[identifier] = name.trim();
    }
  }
  return { ok: true, map: { version: typeof raw.version === "number" ? raw.version : 1, groups, names } };
}

/** "owner/repo#N" or a GitHub PR URL, as a repo and number. */
export function parseStapleConsolePrRef(value: string): { repo: string; number: number; url: string } | null {
  const url = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(value);
  const short = url ?? /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(value.trim());
  if (!short) return null;
  const repo = short[1]!;
  const number = Number(short[2]);
  return { repo, number, url: `https://github.com/${repo}/pull/${number}` };
}

// ---------------------------------------------------------------------------
// Board output

export interface StapleConsoleProofPullRequest {
  label: string;
  url: string;
  state: StapleConsolePrState;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  ci: StapleConsoleCiState;
  source: StapleConsolePullRequestInput["source"];
  /** The installed Staple build contains this merge; null when it cannot be told. */
  inInstalledBuild: boolean | null;
}

export interface StapleConsoleProofReview {
  issueIdentifier: string;
  outcome: StapleConsoleReviewOutcome;
  reviewerName: string | null;
  at: string;
}

export interface StapleConsoleClaimTask {
  identifier: string;
  name: string;
  status: string;
  /** Why this task makes the claim red, when it does. */
  attention: string | null;
  defect: boolean;
}

export interface StapleConsoleClaim {
  id: string;
  text: string;
  why: string;
  state: StapleConsoleClaimState;
  /** One short line on how the color was decided. */
  stateReason: string;
  override: { state: StapleConsoleClaimState; reason: string } | null;
  needsAcceptance: boolean;
  /** Cards on the board that hold the linked tasks (Level 3). */
  cardIds: string[];
  tasks: StapleConsoleClaimTask[];
  proof: {
    pullRequests: StapleConsoleProofPullRequest[];
    reviews: StapleConsoleProofReview[];
    acceptance: { evidence: string[]; at: string | null; note: string | null } | null;
  };
}

export interface StapleConsoleCapability {
  key: string;
  title: string;
  counts: Record<StapleConsoleClaimState, number>;
  claims: StapleConsoleClaim[];
}

export interface StapleConsoleCapabilityGroup {
  key: string;
  label: string;
  capabilities: StapleConsoleCapability[];
}

export interface StapleConsoleCapabilityBoard {
  /** Where the registry came from, or why it is missing. */
  source: {
    available: boolean;
    detail: string;
    issueIdentifier: string | null;
    revisionNumber: number | null;
    updatedAt: string | null;
  };
  installedBuild: string | null;
  groups: StapleConsoleCapabilityGroup[];
}

// ---------------------------------------------------------------------------
// Derivation

/** What the board knows about one linked task. */
export interface StapleConsoleClaimTaskFacts {
  identifier: string;
  name: string;
  status: string;
  terminal: boolean;
  owned: boolean;
  /** Red reasons from the board: a stuck flag, or a question or approval waiting on Ethan. */
  stuckReason: string | null;
  needsEthanReason: string | null;
  cardId: string | null;
  pullRequests: StapleConsoleProofPullRequest[];
  reviews: StapleConsoleProofReview[];
}

export interface StapleConsoleClaimLookups {
  task: (identifier: string) => StapleConsoleClaimTaskFacts | null;
  pullRequest: (ref: { repo: string; number: number; url: string }) => StapleConsoleProofPullRequest | null;
}

function claimAttention(task: StapleConsoleClaimTaskFacts): string | null {
  if (task.terminal) return null;
  if (task.needsEthanReason) return `${task.identifier} waits on Ethan: ${task.needsEthanReason}`;
  if (task.stuckReason) return `${task.identifier} is stuck: ${task.stuckReason}`;
  if (!task.owned) return `${task.identifier} has no owner`;
  if (task.status === "backlog") return `${task.identifier} is in the backlog, nobody is on it`;
  return null;
}

export function deriveStapleConsoleClaim(
  id: string,
  claim: StapleConsoleCapabilityMapClaim,
  lookups: StapleConsoleClaimLookups,
): StapleConsoleClaim {
  const tasks: StapleConsoleClaimTaskFacts[] = [];
  const defectIds = new Set(claim.defects ?? []);
  const missing: string[] = [];
  for (const identifier of [...(claim.issues ?? []), ...(claim.defects ?? [])]) {
    if (tasks.some((task) => task.identifier === identifier)) continue;
    const facts = lookups.task(identifier);
    if (facts) tasks.push(facts);
    else missing.push(identifier);
  }

  const prs = new Map<string, StapleConsoleProofPullRequest>();
  for (const task of tasks) for (const pr of task.pullRequests) prs.set(pr.url.toLowerCase(), pr);
  for (const value of claim.prs ?? []) {
    const ref = parseStapleConsolePrRef(value);
    if (!ref || prs.has(ref.url.toLowerCase())) continue;
    prs.set(ref.url.toLowerCase(), lookups.pullRequest(ref) ?? {
      label: `${ref.repo.split("/")[1] ?? ref.repo}#${ref.number}`,
      url: ref.url,
      state: "unknown",
      mergedAt: null,
      mergeCommitSha: null,
      ci: "unknown",
      source: "reference",
      inInstalledBuild: null,
    });
  }
  const pullRequests = [...prs.values()].sort((a, b) =>
    Number(b.state === "merged") - Number(a.state === "merged") || (Date.parse(b.mergedAt ?? "") || 0) - (Date.parse(a.mergedAt ?? "") || 0));
  const merged = pullRequests.filter((pr) => pr.state === "merged");
  const needsAcceptance = claim.needsAcceptance === true;
  const accepted = Boolean(claim.acceptance && ((claim.acceptance.evidence?.length ?? 0) > 0 || claim.acceptance.at));
  const proven = merged.length > 0 && (!needsAcceptance || accepted);

  const open = tasks.filter((task) => !task.terminal);
  const attention = open.map(claimAttention).filter((reason): reason is string => reason !== null);
  const active = open.filter((task) => claimAttention(task) === null);
  const openDefects = open.filter((task) => defectIds.has(task.identifier));

  let state: StapleConsoleClaimState;
  let stateReason: string;
  // Blue means someone is actively on the gap, so a healthy fix wins over a stuck or waiting sibling.
  // Red is left for gaps nothing is fixing; the sibling's own reason stays in the state reason and proof.
  if (active.length > 0) {
    state = "blue";
    stateReason = `${active.map((task) => task.identifier).join(", ")} ${active.length === 1 ? "is" : "are"} on it`;
    if (attention.length > 0) stateReason += `; ${attention[0]!}`;
  } else if (attention.length > 0) {
    state = "red";
    stateReason = attention[0]!;
  } else if (openDefects.length > 0) {
    state = "red";
    stateReason = `Open defect ${openDefects[0]!.identifier} and nothing fixing it`;
  } else if (proven) {
    state = "green";
    stateReason = needsAcceptance ? `Merged ${merged[0]!.label}, acceptance recorded` : `Merged ${merged[0]!.label}`;
  } else if (merged.length > 0) {
    state = "red";
    stateReason = `Merged ${merged[0]!.label}, but acceptance is not recorded`;
  } else if (tasks.length === 0) {
    state = "red";
    stateReason = missing.length > 0 ? `Linked ${missing.join(", ")} not visible on this board` : "No task is open for this";
  } else {
    state = "red";
    stateReason = "No merged PR and no task open for this";
  }

  const override = claim.override ?? null;
  if (override) {
    if (override.state === "green" && !proven) {
      state = "blue";
      stateReason = merged.length > 0
        ? `Marked works now, but acceptance is not recorded: ${override.reason}`
        : `Marked works now, but no merged PR proves it: ${override.reason}`;
    } else {
      state = override.state;
      stateReason = override.reason;
    }
  }

  const cardIds: string[] = [];
  for (const task of tasks) if (task.cardId && !cardIds.includes(task.cardId)) cardIds.push(task.cardId);
  return {
    id,
    text: claim.text,
    why: claim.why,
    state,
    stateReason,
    override,
    needsAcceptance,
    cardIds,
    tasks: tasks.map((task) => ({
      identifier: task.identifier,
      name: task.name,
      status: task.status,
      attention: claimAttention(task),
      defect: defectIds.has(task.identifier),
    })),
    proof: {
      pullRequests,
      reviews: tasks.flatMap((task) => task.reviews).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 3),
      acceptance: claim.acceptance
        ? { evidence: claim.acceptance.evidence ?? [], at: claim.acceptance.at ?? null, note: claim.acceptance.note ?? null }
        : null,
    },
  };
}

export function deriveStapleConsoleCapabilities(
  document: StapleConsoleCapabilityMapDocumentInput | null | undefined,
  parsed: StapleConsoleCapabilityMapParse | null,
  lookups: StapleConsoleClaimLookups,
  installedBuild: string | null,
): StapleConsoleCapabilityBoard {
  if (!document || !parsed) {
    return {
      source: {
        available: false,
        detail: `No readable ${STAPLE_CONSOLE_CAPABILITY_MAP_KEY} document on ${STAPLE_CONSOLE_CAPABILITY_MAP_OWNER} was found`,
        issueIdentifier: null,
        revisionNumber: null,
        updatedAt: null,
      },
      installedBuild,
      groups: [],
    };
  }
  const source = {
    issueIdentifier: document.issueIdentifier,
    revisionNumber: document.revisionNumber,
    updatedAt: document.updatedAt,
  };
  if (!parsed.ok) return { source: { available: false, detail: parsed.error, ...source }, installedBuild, groups: [] };
  return {
    source: {
      available: true,
      detail: `${document.issueIdentifier} ${STAPLE_CONSOLE_CAPABILITY_MAP_KEY}, revision ${document.revisionNumber}`,
      ...source,
    },
    installedBuild,
    groups: parsed.map.groups.map((group) => ({
      key: group.key,
      label: group.label,
      capabilities: group.capabilities.map((capability) => {
        const claims = capability.claims.map((claim, index) =>
          deriveStapleConsoleClaim(`${group.key}/${capability.key}/${index}`, claim, lookups));
        return {
          key: capability.key,
          title: capability.title,
          counts: {
            green: claims.filter((claim) => claim.state === "green").length,
            blue: claims.filter((claim) => claim.state === "blue").length,
            red: claims.filter((claim) => claim.state === "red").length,
          },
          claims,
        };
      }),
    })),
  };
}
