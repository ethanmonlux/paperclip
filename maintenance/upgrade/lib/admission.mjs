import { validateRegistry } from "./registry.mjs";
import { RECEIPT_SCHEMA } from "./upstream-only.mjs";

const PASS = "pass";
const FAIL = "fail";
const UNKNOWN = "unknown";

function gate(id, status, detail) {
  return { id, status, detail };
}

function evaluatePatch(patch, { upstreamSha, receipts, reviews, implementers }) {
  const id = `patch:${patch.id}`;
  const review = reviews.find((entry) => entry.patchId === patch.id && entry.upstreamSha === upstreamSha);
  if (patch.decision === "unassessed") return gate(id, UNKNOWN, "no keep/adapt/retire decision");
  if (!review) return gate(id, UNKNOWN, `decision ${patch.decision} has no independent review for ${upstreamSha}`);
  if (review.decision !== patch.decision) return gate(id, FAIL, `registry says ${patch.decision} but review says ${review.decision}`);
  if (!review.reviewer || implementers.includes(review.reviewer)) return gate(id, FAIL, "review is not independent of the implementation");
  if (patch.decision !== "retire") return gate(id, PASS, `${patch.decision} independently reviewed by ${review.reviewer}`);
  const receipt = receipts.find((entry) => entry.schema === RECEIPT_SCHEMA && entry.patchId === patch.id && entry.upstreamSha === upstreamSha);
  if (!receipt) return gate(id, UNKNOWN, "retire requires an upstream-only receipt for this upstream SHA");
  if (receipt.outcome !== "upstream-passes") return gate(id, FAIL, `retire contradicted by upstream-only outcome ${receipt.outcome}`);
  if (review.receiptStartedAt !== receipt.startedAt) return gate(id, UNKNOWN, "review does not cite the retained upstream-only receipt");
  return gate(id, PASS, `retire backed by upstream-only pass and review by ${review.reviewer}`);
}

function evaluateCi(candidateSha, ci) {
  if (!ci) return gate("candidate-ci", UNKNOWN, "no exact-head CI evidence");
  if (ci.headSha !== candidateSha) return gate("candidate-ci", FAIL, `CI ran ${ci.headSha}, not ${candidateSha}`);
  if (ci.status !== "completed") return gate("candidate-ci", UNKNOWN, `CI run is ${ci.status}`);
  const jobs = Array.isArray(ci.jobs) ? ci.jobs : [];
  if (jobs.length === 0 || ci.jobsComplete !== true) return gate("candidate-ci", UNKNOWN, "CI job list is empty or not fully paged");
  const accepted = new Set(ci.acceptedNonSuccessJobs ?? []);
  const bad = jobs.filter((job) => job.conclusion !== "success" && !accepted.has(job.name));
  if (bad.length > 0) return gate("candidate-ci", FAIL, `non-success jobs: ${bad.map((job) => `${job.name}=${job.conclusion}`).join(", ")}`);
  return gate("candidate-ci", PASS, `${jobs.length} jobs on exact head`);
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
  if (!candidate?.sha || !candidate?.upstreamSha) gates.push(gate("candidate", FAIL, "candidate sha and upstreamSha are required"));
  else if (candidate.upstreamSha !== registry?.firstCandidateUpstreamSha) {
    gates.push(gate("candidate", FAIL, `candidate upstream ${candidate.upstreamSha} differs from pinned ${registry?.firstCandidateUpstreamSha}`));
  } else gates.push(gate("candidate", PASS, `${candidate.sha} on upstream ${candidate.upstreamSha}`));
  for (const patch of registry?.patches ?? []) {
    gates.push(evaluatePatch(patch, { upstreamSha: candidate?.upstreamSha, receipts, reviews, implementers }));
  }
  gates.push(evaluateCi(candidate?.sha, ci));
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
