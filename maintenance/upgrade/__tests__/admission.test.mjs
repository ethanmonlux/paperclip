import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { evaluateAdmission } from "../lib/admission.mjs";
import { canonicalDigest } from "../lib/digest.mjs";
import { RECEIPT_SCHEMA, receiptDigest } from "../lib/upstream-only.mjs";
import { loadRegistry, validateRegistry } from "../lib/registry.mjs";

const registryPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "patch-registry.json");
const UP = "8595efc20bda3ce20a9fbbf34a5d156a6fcf6d57";
const CAND = "a".repeat(40);

const AUTHORITY = "FAC-760";
const SOURCE = "b".repeat(40);

function minimalRegistry(decision = "keep") {
  return {
    schemaVersion: 1, firstCandidateUpstreamSha: UP, forkPatchSourceSha: SOURCE, automaticActivationEnabled: false, requiredCiJobs: ["verify"],
    patches: [{ id: "p", decision, sourceCommits: ["c".repeat(40)], evidencePaths: ["x.test.ts"], upstreamOnly: { kind: "vitest", testFiles: ["x.test.ts"] } }],
  };
}

const receiptFor = (outcome) => ({ schema: RECEIPT_SCHEMA, attemptId: "a1", patchId: "p", upstreamSha: UP, forkSourceSha: SOURCE, outcome, startedAt: "t1" });

function goodEvidence(registry = minimalRegistry(), outcome = "upstream-fails") {
  const receipt = receiptFor(outcome);
  const bound = { candidateSha: CAND, upstreamSha: UP, authority: AUTHORITY, verdict: "clean", reviewer: "reviewer", implementer: "engineer" };
  return {
    candidate: { sha: CAND, upstreamSha: UP, authority: AUTHORITY },
    implementers: ["engineer"],
    receipts: [receipt],
    reviews: [
      { ...bound, scope: "patch", patchId: "p", decision: registry.patches[0].decision, receiptDigest: receiptDigest(receipt) },
      { ...bound, scope: "candidate", registryDigest: canonicalDigest(registry) },
    ],
    ci: { headSha: CAND, jobsComplete: true, jobs: [{ name: "verify", status: "completed", conclusion: "success" }] },
    migration: { candidateSha: CAND, isolatedCopy: true, result: "applied", appliedCount: 89, previousPayloadCompatible: true },
    isolatedRuntime: { candidateSha: CAND, install: true, boot: true, assets: true, continuation: true, recoveryAfterRestart: true },
  };
}

const remaining = (evidence, registry = minimalRegistry()) => evaluateAdmission({ registry, ...evidence }).remaining;
const gateOf = (evidence, id, registry = minimalRegistry()) => evaluateAdmission({ registry, ...evidence }).gates.find((entry) => entry.id === id);

test("the committed registry is structurally valid, unassessed and not activated", () => {
  const registry = loadRegistry(registryPath);
  assert.deepEqual(validateRegistry(registry), []);
  assert.equal(registry.automaticActivationEnabled, false);
  assert.ok(registry.patches.every((patch) => patch.decision === "unassessed"));
  assert.ok(registry.patches.some((patch) => patch.id === "codex-shell-proxy-allowlist"));
});

test("the committed registry cannot be admitted today, and names its gates", () => {
  const decision = evaluateAdmission({ registry: loadRegistry(registryPath), candidate: { sha: CAND, upstreamSha: UP } });
  assert.equal(decision.admit, false);
  for (const id of ["candidate-ci", "candidate-review", "migration-isolated", "isolated-runtime", "patch:claude-auth-provenance"]) assert.ok(decision.remaining.includes(id), id);
});

test("admits only when every gate has positive evidence", () => {
  assert.deepEqual(remaining(goodEvidence()), []);
});

test("R2: a patch review of another candidate head is stale and never admits", () => {
  const evidence = goodEvidence();
  evidence.reviews[0].candidateSha = "e".repeat(40);
  assert.deepEqual(remaining(evidence), ["patch:p"]);
  assert.match(gateOf(evidence, "patch:p").detail, /another head/);
});

test("R2: a combined-candidate review of another head or registry state never admits", () => {
  const wrongHead = goodEvidence(); wrongHead.reviews[1].candidateSha = "e".repeat(40);
  assert.deepEqual(remaining(wrongHead), ["candidate-review"]);
  const changedRegistry = goodEvidence(); changedRegistry.reviews[1].registryDigest = canonicalDigest({ ...minimalRegistry(), note: "x" });
  assert.deepEqual(remaining(changedRegistry), ["candidate-review"]);
  const noCandidateReview = goodEvidence(); noCandidateReview.reviews.pop();
  assert.deepEqual(remaining(noCandidateReview), ["candidate-review"]);
});

test("R2: reviews bound to another authority or upstream do not count", () => {
  const authority = goodEvidence(); for (const review of authority.reviews) review.authority = "FAC-1";
  assert.deepEqual(remaining(authority), ["patch:p", "candidate-review"]);
  const missingAuthority = goodEvidence(); delete missingAuthority.candidate.authority;
  assert.ok(remaining(missingAuthority).includes("candidate"));
});

test("R2: a missing or non-clean verdict fails, even beside a clean review", () => {
  for (const verdict of [undefined, "block", "findings"]) {
    const evidence = goodEvidence();
    evidence.reviews[0].verdict = verdict;
    assert.equal(gateOf(evidence, "patch:p").status, "fail", String(verdict));
    const mixed = goodEvidence();
    mixed.reviews.push({ ...mixed.reviews[1], reviewer: "second", verdict });
    assert.equal(gateOf(mixed, "candidate-review").status, "fail", String(verdict));
  }
});

test("R2: missing implementer provenance or a self-review fails", () => {
  const noImplementers = goodEvidence(); noImplementers.implementers = [];
  assert.deepEqual(remaining(noImplementers), ["implementers", "patch:p", "candidate-review"]);
  const reviewNamesNoImplementer = goodEvidence(); delete reviewNamesNoImplementer.reviews[0].implementer;
  assert.equal(gateOf(reviewNamesNoImplementer, "patch:p").status, "fail");
  const unknownImplementer = goodEvidence(); unknownImplementer.reviews[1].implementer = "someone-else";
  assert.equal(gateOf(unknownImplementer, "candidate-review").status, "fail");
  const selfReview = goodEvidence(); selfReview.reviews[0].reviewer = "engineer";
  assert.equal(gateOf(selfReview, "patch:p").status, "fail");
});

test("R2: a patch decision is bound to the exact receipt the reviewer cited", () => {
  const uncited = goodEvidence(); delete uncited.reviews[0].receiptDigest;
  assert.deepEqual(remaining(uncited), ["patch:p"]);
  const notSupplied = goodEvidence(); notSupplied.receipts = [];
  assert.deepEqual(remaining(notSupplied), ["patch:p"]);
  const altered = goodEvidence(); altered.receipts[0].outcome = "upstream-passes";
  assert.deepEqual(remaining(altered), ["patch:p"], "an edited receipt no longer matches the cited digest");
  const otherSource = goodEvidence(); otherSource.receipts[0].forkSourceSha = "d".repeat(40);
  otherSource.reviews[0].receiptDigest = receiptDigest(otherSource.receipts[0]);
  assert.equal(gateOf(otherSource, "patch:p").status, "fail");
  const oldSchema = goodEvidence(); oldSchema.receipts[0].schema = "staple.upgrade.upstream-only.v1";
  oldSchema.reviews[0].receiptDigest = receiptDigest(oldSchema.receipts[0]);
  assert.equal(gateOf(oldSchema, "patch:p").status, "fail");
});

test("retiring a patch requires the cited receipt to be an upstream-only pass", () => {
  const registry = minimalRegistry("retire");
  assert.equal(gateOf(goodEvidence(registry, "upstream-fails"), "patch:p", registry).status, "fail");
  assert.equal(gateOf(goodEvidence(registry, "unknown"), "patch:p", registry).status, "fail");
  assert.deepEqual(remaining(goodEvidence(registry, "upstream-passes"), registry), []);
  const decisionMismatch = goodEvidence(registry, "upstream-passes"); decisionMismatch.reviews[0].decision = "keep";
  assert.equal(gateOf(decisionMismatch, "patch:p", registry).status, "fail");
});

test("R3: caller-supplied CI exemptions cannot waive a failed required check", () => {
  const evidence = goodEvidence();
  evidence.ci.jobs[0].conclusion = "failure";
  evidence.ci.acceptedNonSuccessJobs = ["verify"];
  assert.equal(gateOf(evidence, "candidate-ci").status, "fail");
  delete evidence.ci.acceptedNonSuccessJobs;
  assert.equal(gateOf(evidence, "candidate-ci").status, "fail");
  const greenWithExemption = goodEvidence(); greenWithExemption.ci.acceptedNonSuccessJobs = [];
  assert.equal(gateOf(greenWithExemption, "candidate-ci").status, "fail");
});

test("R3: any failed, skipped or non-terminal check blocks, including non-required ones", () => {
  const review = goodEvidence();
  review.ci.jobs.push({ name: "commitperclip PR Review", status: "completed", conclusion: "failure" });
  assert.equal(gateOf(review, "candidate-ci").status, "fail");
  const skipped = goodEvidence(); skipped.ci.jobs.push({ name: "e2e", status: "completed", conclusion: "skipped" });
  assert.equal(gateOf(skipped, "candidate-ci").status, "fail");
  for (const status of ["in_progress", "queued", undefined]) {
    const pending = goodEvidence(); pending.ci.jobs[0] = { name: "verify", status, conclusion: status ? null : "success" };
    assert.equal(gateOf(pending, "candidate-ci").status, "unknown", String(status));
  }
});

test("R3: the reviewed required-check set must be declared and present", () => {
  const absent = goodEvidence(); absent.ci.jobs[0].name = "other";
  assert.equal(gateOf(absent, "candidate-ci").status, "fail");
  const undeclared = minimalRegistry(); delete undeclared.requiredCiJobs;
  assert.equal(gateOf(goodEvidence(undeclared), "candidate-ci", undeclared).status, "unknown");
  assert.match(validateRegistry({ ...minimalRegistry(), requiredCiJobs: [] }).join(), /requiredCiJobs/);
});

test("mismatched CI heads and incomplete paging fail closed", () => {
  const wrongHead = goodEvidence(); wrongHead.ci.headSha = "d".repeat(40);
  assert.equal(gateOf(wrongHead, "candidate-ci").status, "fail");
  const jobHead = goodEvidence(); jobHead.ci.jobs[0].headSha = "d".repeat(40);
  assert.equal(gateOf(jobHead, "candidate-ci").status, "fail");
  const paged = goodEvidence(); paged.ci.jobsComplete = false;
  assert.equal(gateOf(paged, "candidate-ci").status, "unknown");
});

test("schema-incompatible rollback blocks automatic admission", () => {
  const evidence = goodEvidence(); evidence.migration.previousPayloadCompatible = false;
  assert.deepEqual(remaining(evidence), ["rollback-schema-compatible"]);
});

test("automatic activation cannot be enabled without a controlled upgrade proof", () => {
  const registry = { ...minimalRegistry(), automaticActivationEnabled: true };
  assert.match(validateRegistry(registry).join(), /automaticActivationEnabled/);
});
