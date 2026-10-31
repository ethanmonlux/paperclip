import { canonicalDigest } from "./digest.mjs";
import { validateRegistry } from "./registry.mjs";
import { RECEIPT_SCHEMA, receiptDigest } from "./upstream-only.mjs";

const PASS = "pass";
const FAIL = "fail";
const UNKNOWN = "unknown";
const CLEAN = "clean";

function gate(id, status, detail) {
  return { id, status, detail };
}

/**
 * A review counts only for the exact candidate head, upstream and authority it
 * names. Any review of another head is stale and ignored, so changing the
 * candidate always requires fresh review.
 */
function isCurrent(review, candidate) {
  return review.candidateSha === candidate.sha && review.upstreamSha === candidate.upstreamSha && review.authority === candidate.authority;
}

function reviewProblem(review, implementers) {
  if (review.verdict === undefined) return "review has no explicit verdict";
  if (review.verdict !== CLEAN) return `review verdict is ${review.verdict}`;
  if (!review.reviewer) return "review names no reviewer";
  if (!review.implementer) return "review names no implementer";
  if (!implementers.includes(review.implementer)) return `reviewed implementer ${review.implementer} is not a recorded implementer`;
  if (implementers.includes(review.reviewer)) return "review is not independent of the implementation";
  return null;
}

/** Every current review must be clean and independent; at least one must exist. */
function currentReviews(id, matching, candidate, implementers) {
  const current = matching.filter((review) => isCurrent(review, candidate));
  if (current.length === 0) {
    const stale = matching.length > 0 ? ` (${matching.length} review(s) of another head, upstream or authority ignored)` : "";
    return { result: gate(id, UNKNOWN, `no independent review of candidate ${candidate.sha}${stale}`) };
  }
  for (const review of current) {
    const problem = reviewProblem(review, implementers);
    if (problem) return { result: gate(id, FAIL, `${problem} (reviewer ${review.reviewer ?? "unnamed"})`) };
  }
  return { current };
}

function evaluatePatch(patch, { registry, candidate, receipts, reviews, implementers }) {
  const id = `patch:${patch.id}`;
  if (patch.decision === "unassessed") return gate(id, UNKNOWN, "no keep/adapt/retire decision");
  const matching = reviews.filter((review) => review.scope === "patch" && review.patchId === patch.id);
  const { result, current } = currentReviews(id, matching, candidate, implementers);
  if (result) return result;
  const sourceSha = patch.upstreamOnly?.sourceSha ?? registry.evidenceSourceSha ?? registry.forkPatchSourceSha;
  for (const review of current) {
    if (review.decision !== patch.decision) return gate(id, FAIL, `registry says ${patch.decision} but ${review.reviewer} reviewed ${review.decision}`);
    // The decision is bound to the exact upstream-only receipt the reviewer read.
    if (!review.receiptDigest) return gate(id, UNKNOWN, `review by ${review.reviewer} cites no upstream-only receipt`);
    const receipt = receipts.find((entry) => receiptDigest(entry) === review.receiptDigest);
    if (!receipt) return gate(id, UNKNOWN, `cited receipt ${review.receiptDigest} was not supplied`);
    if (receipt.schema !== RECEIPT_SCHEMA || receipt.patchId !== patch.id || receipt.upstreamSha !== candidate.upstreamSha || receipt.forkSourceSha !== sourceSha) {
      return gate(id, FAIL, `cited receipt is not an upstream-only run of ${patch.id} from ${sourceSha} on ${candidate.upstreamSha}`);
    }
    if (patch.decision === "retire" && receipt.outcome !== "upstream-passes") {
      return gate(id, FAIL, `retire contradicted by upstream-only outcome ${receipt.outcome}`);
    }
  }
  return gate(id, PASS, `${patch.decision} reviewed by ${current.map((review) => review.reviewer).join(", ")} for ${candidate.sha}`);
}

function evaluateCandidateReview({ registry, candidate, reviews, implementers }) {
  const id = "candidate-review";
  const registryDigest = canonicalDigest(registry);
  const matching = reviews.filter((review) => review.scope === "candidate");
  const bound = matching.filter((review) => review.registryDigest === registryDigest);
  const { result, current } = currentReviews(id, bound, candidate, implementers);
  if (result) {
    if (result.status === UNKNOWN && bound.length < matching.length) {
      return gate(id, UNKNOWN, `${result.detail}; ${matching.length - bound.length} review(s) of another registry state ignored`);
    }
    return result;
  }
  return gate(id, PASS, `combined candidate reviewed by ${current.map((review) => review.reviewer).join(", ")}`);
}

/**
 * `ci.jobs` must be every check run reported for the head across all
 * workflows, fully paged. There are no exemptions: any terminal non-success
 * fails, anything not yet terminal is unknown, and the registry's reviewed
 * required-job set must be present.
 */
function evaluateCi(candidateSha, ci, requiredJobs) {
  const id = "candidate-ci";
  if (!ci) return gate(id, UNKNOWN, "no exact-head CI evidence");
  if (ci.acceptedNonSuccessJobs !== undefined) return gate(id, FAIL, "CI exemptions are not accepted; every check must succeed");
  if (ci.headSha !== candidateSha) return gate(id, FAIL, `CI ran ${ci.headSha}, not ${candidateSha}`);
  const jobs = Array.isArray(ci.jobs) ? ci.jobs : [];
  if (jobs.length === 0 || ci.jobsComplete !== true) return gate(id, UNKNOWN, "CI check list is empty or not fully paged");
  const otherHead = jobs.filter((job) => job.headSha !== undefined && job.headSha !== candidateSha);
  if (otherHead.length > 0) return gate(id, FAIL, `checks from another head: ${otherHead.map((job) => job.name).join(", ")}`);
  const failed = jobs.filter((job) => job.status === "completed" && job.conclusion !== "success");
  if (failed.length > 0) return gate(id, FAIL, `non-success checks: ${failed.map((job) => `${job.name}=${job.conclusion}`).join(", ")}`);
  const pending = jobs.filter((job) => job.status !== "completed");
  if (pending.length > 0) return gate(id, UNKNOWN, `checks not terminal: ${pending.map((job) => `${job.name}=${job.status}`).join(", ")}`);
  if (!Array.isArray(requiredJobs) || requiredJobs.length === 0) return gate(id, UNKNOWN, "registry declares no required CI check set");
  const missing = requiredJobs.filter((name) => !jobs.some((job) => job.name === name));
  if (missing.length > 0) return gate(id, FAIL, `required checks absent: ${missing.join(", ")}`);
  return gate(id, PASS, `${jobs.length} checks succeeded on exact head, including ${requiredJobs.length} required`);
}

function evaluateMigration(candidateSha, migration) {
  if (!migration) return [gate("migration-isolated", UNKNOWN, "no isolated database-copy migration evidence")];
  const gates = [];
  if (migration.candidateSha !== candidateSha || migration.isolatedCopy !== true || migration.result !== "applied") {
    gates.push(gate("migration-isolated", FAIL, "migration evidence is not an applied run of this candidate on an isolated copy"));
  } else gates.push(gate("migration-isolated", PASS, `${migration.appliedCount ?? "?"} migrations applied on isolated copy`));
  gates.push(migration.previousPayloadCompatible === true
    ? gate("rollback-schema-compatible", PASS, "previous payload verified against migrated schema")
    : gate("rollback-schema-compatible", FAIL, "automatic payload rollback is not schema-safe; owner-controlled recovery required"));
  return gates;
}

/**
 * Fail-closed admission for one combined upstream candidate. Every gate must
 * pass; `unknown` never admits. This evaluates recorded evidence only; it does
 * not create any evidence.
 */
export function evaluateAdmission({ registry, candidate, receipts = [], reviews = [], implementers = [], ci = null, migration = null, isolatedRuntime = null }) {
  const gates = [];
  const registryErrors = validateRegistry(registry);
  gates.push(registryErrors.length === 0 ? gate("registry", PASS, "valid") : gate("registry", FAIL, registryErrors.join("; ")));
  if (!candidate?.sha || !candidate?.upstreamSha || !candidate?.authority) {
    gates.push(gate("candidate", FAIL, "candidate sha, upstreamSha and authority are required"));
  } else if (candidate.upstreamSha !== registry?.firstCandidateUpstreamSha) {
    gates.push(gate("candidate", FAIL, `candidate upstream ${candidate.upstreamSha} differs from pinned ${registry?.firstCandidateUpstreamSha}`));
  } else gates.push(gate("candidate", PASS, `${candidate.sha} on upstream ${candidate.upstreamSha} under ${candidate.authority}`));
  const knownImplementers = Array.isArray(implementers) && implementers.length > 0 && implementers.every((name) => typeof name === "string" && name);
  gates.push(knownImplementers
    ? gate("implementers", PASS, implementers.join(", "))
    : gate("implementers", FAIL, "implementer provenance is required to establish review independence"));
  const context = { registry, candidate: candidate ?? {}, receipts, reviews: Array.isArray(reviews) ? reviews : [], implementers: knownImplementers ? implementers : [] };
  for (const patch of registry?.patches ?? []) gates.push(evaluatePatch(patch, context));
  gates.push(evaluateCandidateReview(context));
  gates.push(evaluateCi(candidate?.sha, ci, registry?.requiredCiJobs));
  gates.push(...evaluateMigration(candidate?.sha, migration));
  if (!isolatedRuntime) gates.push(gate("isolated-runtime", UNKNOWN, "no isolated install/boot/assets/continuation evidence"));
  else {
    const missing = ["install", "boot", "assets", "continuation", "recoveryAfterRestart"].filter((key) => isolatedRuntime[key] !== true);
    gates.push(isolatedRuntime.candidateSha === candidate?.sha && missing.length === 0
      ? gate("isolated-runtime", PASS, "isolated install, boot, assets, continuation and restart recovery proved")
      : gate("isolated-runtime", FAIL, `isolated runtime evidence incomplete: ${missing.join(", ") || "candidate mismatch"}`));
  }
  const remaining = gates.filter((entry) => entry.status !== PASS).map((entry) => entry.id);
  return { admit: remaining.length === 0, gates, remaining };
}
