import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { evaluateAdmission } from "../lib/admission.mjs";
import { loadRegistry, validateRegistry } from "../lib/registry.mjs";

const registryPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "patch-registry.json");
const UP = "8595efc20bda3ce20a9fbbf34a5d156a6fcf6d57";
const CAND = "a".repeat(40);

function minimalRegistry(decision = "keep") {
  return {
    schemaVersion: 1, firstCandidateUpstreamSha: UP, forkPatchSourceSha: "b".repeat(40), automaticActivationEnabled: false,
    patches: [{ id: "p", decision, sourceCommits: ["c".repeat(40)], evidencePaths: ["x.test.ts"], upstreamOnly: { kind: "vitest", testFiles: ["x.test.ts"] } }],
  };
}

const goodEvidence = () => ({
  candidate: { sha: CAND, upstreamSha: UP },
  implementers: ["engineer"],
  reviews: [{ patchId: "p", upstreamSha: UP, decision: "keep", reviewer: "reviewer" }],
  ci: { headSha: CAND, status: "completed", jobsComplete: true, jobs: [{ name: "verify", conclusion: "success" }] },
  migration: { candidateSha: CAND, isolatedCopy: true, result: "applied", appliedCount: 89, previousPayloadCompatible: true },
  isolatedRuntime: { candidateSha: CAND, install: true, boot: true, assets: true, continuation: true, recoveryAfterRestart: true },
});

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
  for (const id of ["candidate-ci", "migration-isolated", "isolated-runtime", "patch:claude-auth-provenance"]) assert.ok(decision.remaining.includes(id), id);
});

test("admits only when every gate has positive evidence", () => {
  assert.deepEqual(evaluateAdmission({ registry: minimalRegistry(), ...goodEvidence() }).remaining, []);
});

test("self-review, mismatched CI heads, skipped jobs and incomplete paging fail closed", () => {
  const selfReview = goodEvidence(); selfReview.reviews[0].reviewer = "engineer";
  assert.ok(evaluateAdmission({ registry: minimalRegistry(), ...selfReview }).remaining.includes("patch:p"));
  const wrongHead = goodEvidence(); wrongHead.ci.headSha = "d".repeat(40);
  assert.ok(evaluateAdmission({ registry: minimalRegistry(), ...wrongHead }).remaining.includes("candidate-ci"));
  const skipped = goodEvidence(); skipped.ci.jobs.push({ name: "e2e", conclusion: "skipped" });
  assert.ok(evaluateAdmission({ registry: minimalRegistry(), ...skipped }).remaining.includes("candidate-ci"));
  const paged = goodEvidence(); paged.ci.jobsComplete = false;
  assert.ok(evaluateAdmission({ registry: minimalRegistry(), ...paged }).remaining.includes("candidate-ci"));
});

test("retiring a patch requires a matching upstream-only pass cited by the review", () => {
  const evidence = goodEvidence();
  evidence.reviews[0].decision = "retire";
  const receipt = { schema: "staple.upgrade.upstream-only.v1", patchId: "p", upstreamSha: UP, outcome: "upstream-fails", startedAt: "t1" };
  assert.ok(evaluateAdmission({ registry: minimalRegistry("retire"), ...evidence }).remaining.includes("patch:p"));
  assert.ok(evaluateAdmission({ registry: minimalRegistry("retire"), ...evidence, receipts: [receipt] }).remaining.includes("patch:p"));
  const pass = { ...receipt, outcome: "upstream-passes" };
  assert.ok(evaluateAdmission({ registry: minimalRegistry("retire"), ...evidence, receipts: [pass] }).remaining.includes("patch:p"));
  evidence.reviews[0].receiptStartedAt = "t1";
  assert.deepEqual(evaluateAdmission({ registry: minimalRegistry("retire"), ...evidence, receipts: [pass] }).remaining, []);
});

test("schema-incompatible rollback blocks automatic admission", () => {
  const evidence = goodEvidence(); evidence.migration.previousPayloadCompatible = false;
  assert.deepEqual(evaluateAdmission({ registry: minimalRegistry(), ...evidence }).remaining, ["rollback-schema-compatible"]);
});

test("automatic activation cannot be enabled without a controlled upgrade proof", () => {
  const registry = { ...minimalRegistry(), automaticActivationEnabled: true };
  assert.match(validateRegistry(registry).join(), /automaticActivationEnabled/);
});
