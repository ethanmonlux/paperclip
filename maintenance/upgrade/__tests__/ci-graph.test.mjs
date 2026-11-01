import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { evaluateAdmission } from "../lib/admission.mjs";
import { buildCiGraph, verifyCiGraph } from "../lib/ci-graph.mjs";
import { ciGraphFromGit, workflowsAt } from "../lib/ci-graph-git.mjs";
import { canonicalDigest } from "../lib/digest.mjs";
import { loadRegistry } from "../lib/registry.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const committedGraph = JSON.parse(readFileSync(path.join(repoRoot, "maintenance", "ci-graph.json"), "utf8"));
const registry = loadRegistry(path.join(repoRoot, "maintenance", "patch-registry.json"));
const PIN = "1".repeat(40);
const CAND = "a".repeat(40);

const PR = `name: PR
on:
  pull_request:
jobs:
  ci:
    uses: owner/repo/.github/workflows/trusted.yml@${PIN}
  toolkit:
    name: toolkit
    runs-on: ubuntu-latest
`;

// Shape of the pinned trusted workflow: an aggregate that does not need every lane.
const TRUSTED = `on:
  workflow_call:
jobs:
  gate:
    name: Select runner
    runs-on: ubuntu-latest
  shard:
    name: Shard (\${{ matrix.label }})
    needs: [gate]
    strategy:
      fail-fast: false
      matrix:
        include:
          - index: 0
            label: 1/2
          - index: 1
            label: "2/2"
    steps:
      - run: echo "key: *not-an-alias"
  build:
    needs: gate
    runs-on: ubuntu-latest
  verify:
    name: verify
    if: \${{ always() }}
    needs: [gate, build]
`;

const REVIEW = `on:
  pull_request_target:
    types: [opened, synchronize, reopened]
jobs:
  review:
    runs-on: ubuntu-latest
`;

const file = (name, text) => ({ path: `.github/workflows/${name}`, blob: canonicalDigest(text).slice(0, 40), text });
const calls = { [`owner/repo@${PIN}:.github/workflows/trusted.yml`]: TRUSTED };
const resolveCall = (repository, sha, target) => {
  const text = calls[`${repository}@${sha}:${target}`];
  return text === undefined ? null : { blob: canonicalDigest(text).slice(0, 40), text };
};
const graphOf = ({ head = [file("pr.yml", PR), file("review.yml", REVIEW)], base = [file("review.yml", REVIEW)] } = {}) =>
  buildCiGraph({ head, base, baseContext: "origin/main", resolveCall });
const names = (graph) => graph.checks.map((check) => check.name);

test("expands reusable calls, matrices and base-context targets into exact check names", () => {
  const graph = graphOf();
  assert.equal(graph.unsupported, undefined);
  assert.deepEqual(names(graph), ["ci / Select runner", "ci / Shard (1/2)", "ci / Shard (2/2)", "ci / build", "ci / verify", "review", "toolkit"]);
  // The head's own pull_request_target file never runs; the base branch's does.
  assert.deepEqual(graph.workflows.map((entry) => `${entry.path}:${entry.context}`), [".github/workflows/pr.yml:head", ".github/workflows/review.yml:base"]);
  assert.equal(graph.calls[0].uses, `owner/repo/.github/workflows/trusted.yml@${PIN}`);
});

test("records aggregate coverage, including lanes an aggregate does not need", () => {
  const verify = graphOf().aggregates.find((entry) => entry.check === "ci / verify");
  assert.deepEqual(verify.needs, ["ci / Select runner", "ci / build"]);
  assert.ok(!verify.needs.some((name) => name.startsWith("ci / Shard")));
});

test("path-, branch- and activity-filtered workflows are conditional, not expected", () => {
  const filtered = `on:\n  pull_request:\n    paths:\n      - server/**\njobs:\n  x:\n    runs-on: ubuntu-latest\n`;
  const branch = `on:\n  pull_request:\n    branches: [master]\njobs:\n  y:\n    runs-on: ubuntu-latest\n`;
  const labeled = `on:\n  pull_request:\n    types: [labeled]\njobs:\n  z:\n    runs-on: ubuntu-latest\n`;
  const graph = graphOf({ head: [file("pr.yml", PR), file("f.yml", filtered), file("b.yml", branch), file("l.yml", labeled)], base: [] });
  assert.ok(!names(graph).some((name) => ["x", "y", "z"].includes(name)));
  assert.deepEqual(graph.workflows.filter((entry) => !entry.required).map((entry) => entry.filters[0]), ["branches=master", "paths=server/**", "types=labeled"]);
});

test("workflows that never run for a pull request may use any YAML", () => {
  const scheduled = `on:\n  schedule:\n    - cron: "0 0 * * *"\njobs:\n  a:\n    steps: &steps\n      - run: x\n`;
  assert.equal(graphOf({ head: [file("pr.yml", PR), file("s.yml", scheduled)], base: [] }).unsupported, undefined);
});

test("shapes the reader cannot expand exactly are unsupported, never guessed", () => {
  const cases = {
    "dynamic matrix": TRUSTED.replace(/matrix:\n {8}include:[\s\S]*?"2\/2"\n/, "matrix: ${{ fromJSON(needs.gate.outputs.m) }}\n"),
    "matrix exclude": TRUSTED.replace("        include:", "        exclude:\n          - index: 2\n        include:"),
    "expression in matrix value": TRUSTED.replace("label: 1/2", "label: ${{ github.ref }}"),
    "no explicit name": TRUSTED.replace("    name: Shard (${{ matrix.label }})\n", ""),
    "unknown job": TRUSTED.replace("needs: [gate, build]", "needs: [gate, missing]"),
    "anchor or alias": TRUSTED.replace("    runs-on: ubuntu-latest\n  shard:", "    runs-on: ubuntu-latest\n    steps: &steps\n      - run: x\n  shard:"),
    "block scalar": TRUSTED.replace("    name: verify\n", "    name: >-\n      verify\n"),
  };
  for (const [label, text] of Object.entries(cases)) {
    calls[`owner/repo@${PIN}:.github/workflows/trusted.yml`] = text;
    try {
      assert.ok(graphOf().unsupported, label);
    } finally {
      calls[`owner/repo@${PIN}:.github/workflows/trusted.yml`] = TRUSTED;
    }
  }
  const mutable = PR.replace(`@${PIN}`, "@main");
  assert.match(graphOf({ head: [file("pr.yml", mutable)], base: [] }).unsupported, /immutable full-SHA/);
  const unavailable = PR.replace(`@${PIN}`, `@${"2".repeat(40)}`);
  assert.match(graphOf({ head: [file("pr.yml", unavailable)], base: [] }).unsupported, /not available/);
});

test("a changed workflow blob or lane set is unknown until the new graph is reviewed", () => {
  const reviewed = graphOf();
  assert.equal(verifyCiGraph({ committed: reviewed, regenerated: graphOf() }).status, "pass");
  const changed = graphOf({ head: [file("pr.yml", `${PR}  extra:\n    name: extra\n`), file("review.yml", REVIEW)] });
  const stale = verifyCiGraph({ committed: reviewed, regenerated: changed });
  assert.equal(stale.status, "unknown");
  assert.match(stale.detail, /new lane extra/);
  assert.match(stale.detail, /workflow now \.github\/workflows\/pr\.yml@/);
  assert.equal(verifyCiGraph({ committed: reviewed, regenerated: { unsupported: "x" } }).status, "unknown");
  assert.equal(verifyCiGraph({ committed: null, regenerated: reviewed }).status, "unknown");
});

// --- R5: trigger syntax is decoded exactly or rejected ---------------------

// The reviewer's reproduction: a valid YAML flow mapping that once vanished.
const FLOW_PR = `on: {pull_request: {}}
jobs:
  required_security:
    runs-on: ubuntu-latest
`;
const job = "jobs:\n  x:\n    runs-on: ubuntu-latest\n";

test("R5: a flow-mapping pull_request trigger is unsupported, not dropped", () => {
  const graph = graphOf({ head: [file("pr.yml", PR), file("security.yml", FLOW_PR)], base: [] });
  assert.match(graph.unsupported ?? "", /security\.yml:on: trigger "\{pull_request: \{\}\}" is not a plain event name/);
  assert.equal(graph.checks, undefined);
});

test("R5: a flow-mapping pull_request_target trigger in the base context is unsupported", () => {
  const target = FLOW_PR.replace("pull_request", "pull_request_target");
  assert.match(graphOf({ base: [file("review.yml", REVIEW), file("t.yml", target)] }).unsupported ?? "", /t\.yml:on: trigger/);
  // The head's copy never runs for pull_request_target, but its trigger must still be decodable.
  assert.match(graphOf({ head: [file("pr.yml", PR), file("t.yml", target)], base: [file("review.yml", REVIEW)] }).unsupported ?? "", /t\.yml:on: trigger/);
});

test("R5: every structurally undecoded trigger form is unsupported", () => {
  const cases = {
    "flow mapping of a non-PR event": "on: {push: {}}\n",
    "flow mapping inside a flow list": "on: [push, {pull_request: {}}]\n",
    "inline pull_request configuration": "on:\n  pull_request: {types: [opened]}\n",
    "inline pull_request_target configuration": "on:\n  pull_request_target: {branches: [master]}\n",
    "inline value and a block": "on:\n  pull_request: {}\n    branches: [master]\n",
    "quoted event key": "on:\n  \"pull_request\":\n",
    "non-plain event name": "on: pull-request\n",
    "unknown pull_request key": "on:\n  pull_request:\n    tags: [v1]\n",
    "flow mapping as a filter value": "on:\n  pull_request:\n    branches: {master: x}\n",
    "nested flow filter": "on:\n  pull_request:\n    branches: [{a: b}]\n",
    "expression in types": "on:\n  pull_request:\n    types: [\"${{ x }}\"]\n",
    "filter list not a list": "on:\n  pull_request:\n    paths:\n      a: b\n",
    "event mapping is a list": "on:\n  - pull_request\n",
    "inline on and a block": "on: push\n  pull_request:\n",
    "empty on block": "on:\n",
    "missing on": "",
    "duplicate on key": "on: push\non: pull_request\n",
    "duplicate event key": "on:\n  push:\n  push:\n  pull_request:\n",
    "duplicate trigger in flow list": "on: [pull_request, pull_request]\n",
    "block scalar trigger": "on: >\n  pull_request\n",
    "anchor in trigger": "on:\n  pull_request: &pr\n",
    "tab-led line": "on:\n\tpull_request:\n",
    "top-level flow document": "{on: pull_request, jobs: {x: {runs-on: a}}}\n",
    "second YAML document": "on: push\n---\non: pull_request\n",
  };
  for (const [label, trigger] of Object.entries(cases)) {
    const text = label === "top-level flow document" ? trigger : `${trigger}${job}`;
    assert.ok(graphOf({ head: [file("pr.yml", PR), file("w.yml", text)], base: [] }).unsupported, label);
  }
});

test("R5: the decoded trigger forms keep their meaning", () => {
  const lanes = (trigger) => names(graphOf({ head: [file("pr.yml", PR), file("w.yml", `${trigger}${job}`)], base: [] }));
  for (const trigger of ["on: pull_request\n", "on: [push, pull_request]\n", "on:  # comment\n  pull_request: {}\n", "on:\n  pull_request: null\n", "on:\n  push:\n  pull_request:\n    types: [opened, synchronize]\n"]) {
    assert.ok(lanes(trigger).includes("x"), trigger);
  }
  for (const trigger of ["on: push\n", "on:\n  workflow_dispatch:\n    inputs:\n      a: {type: string}\n", "on:\n  pull_request:\n    paths: [a/**]\n"]) {
    assert.ok(!lanes(trigger).includes("x"), trigger);
  }
});

test("R5: symlinked or unreadable workflow files are unsupported", () => {
  assert.match(graphOf({ head: [file("pr.yml", PR), { ...file("l.yml", "x"), mode: "120000" }], base: [] }).unsupported ?? "", /mode 120000/);
  assert.match(graphOf({ head: [file("pr.yml", PR), { path: ".github/workflows/u.yaml", blob: "b".repeat(40) }], base: [] }).unsupported ?? "", /text unavailable/);
});

test("R5: every workflow file is pinned, so an added, changed or removed one is never invisible", () => {
  const reviewed = graphOf();
  const scheduled = `on:\n  schedule:\n    - cron: "0 0 * * *"\n${job}`;
  const variants = {
    "added non-PR workflow": graphOf({ head: [file("pr.yml", PR), file("review.yml", REVIEW), file("s.yml", scheduled)] }),
    "changed non-PR workflow (head copy of review.yml)": graphOf({ head: [file("pr.yml", PR), file("review.yml", `${REVIEW}  more:\n    runs-on: x\n`)] }),
    "removed workflow": graphOf({ head: [file("pr.yml", PR)] }),
    "added base-context workflow": graphOf({ base: [file("review.yml", REVIEW), file("s.yml", scheduled)] }),
    "non-YAML file in the workflow directory": graphOf({ head: [file("pr.yml", PR), file("review.yml", REVIEW), file("README.md", "x")] }),
  };
  for (const [label, regenerated] of Object.entries(variants)) {
    assert.equal(regenerated.unsupported, undefined, label);
    assert.deepEqual(names(regenerated), names(reviewed), `${label}: same lanes, so only the file pins can catch it`);
    const verified = verifyCiGraph({ committed: reviewed, regenerated });
    assert.equal(verified.status, "unknown", label);
    assert.match(verified.detail, /workflow (now|was) (head|base):\.github\/workflows\//, label);
  }
});

// --- The real, pinned graph of this repository ---------------------------

test("the committed graph is exactly what this head's workflow blobs produce", () => {
  // CI passes the PR head; locally HEAD is the candidate.
  const candidate = process.env.UPGRADE_TOOLKIT_CI_GRAPH_CANDIDATE || "HEAD";
  const regenerated = ciGraphFromGit(repoRoot, { candidate, baseContext: committedGraph.baseContext });
  const verified = verifyCiGraph({ committed: committedGraph, regenerated });
  assert.equal(verified.status, "pass", verified.detail);
  assert.equal(registry.ciGraphDigest, canonicalDigest(committedGraph));
});

test("R5: adding a workflow to this repository's real inputs never leaves the reviewed graph passing", () => {
  const candidate = process.env.UPGRADE_TOOLKIT_CI_GRAPH_CANDIDATE || "HEAD";
  const head = workflowsAt(repoRoot, candidate);
  const base = workflowsAt(repoRoot, committedGraph.baseContext);
  const resolveCall = (_repository, sha, target) => {
    const reviewedCall = committedGraph.calls.find((call) => call.uses.endsWith(`${target}@${sha}`));
    const blob = reviewedCall?.blob;
    const text = blob ? spawnSync("git", ["-C", repoRoot, "cat-file", "blob", blob], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).stdout : null;
    return text ? { blob, text } : null;
  };
  const rebuild = (extraHead = [], extraBase = []) => verifyCiGraph({
    committed: committedGraph,
    regenerated: buildCiGraph({ head: [...head, ...extraHead], base: [...base, ...extraBase], baseContext: committedGraph.baseContext, resolveCall }),
  });
  assert.equal(rebuild().status, "pass", "unchanged inputs reproduce the committed graph");
  const flow = rebuild([file("security.yml", FLOW_PR)]);
  assert.equal(flow.status, "unknown");
  assert.match(flow.detail, /unsupported workflow graph: .*security\.yml/);
  const flowTarget = rebuild([], [file("t.yml", FLOW_PR.replace("pull_request", "pull_request_target"))]);
  assert.equal(flowTarget.status, "unknown");
  assert.match(flowTarget.detail, /unsupported workflow graph/);
  const block = rebuild([file("security.yml", FLOW_PR.replace("on: {pull_request: {}}", "on:\n  pull_request:"))]);
  assert.equal(block.status, "unknown");
  assert.match(block.detail, /new lane required_security/);
  const silent = rebuild([file("nightly.yml", `on:\n  schedule:\n    - cron: "0 0 * * *"\n${job}`)]);
  assert.equal(silent.status, "unknown");
  assert.match(silent.detail, /workflow now head:\.github\/workflows\/nightly\.yml@/);
});

test("the reviewed graph expects the serialized server shards, review and every matrix lane", () => {
  const expected = names(committedGraph);
  for (let shard = 1; shard <= 9; shard += 1) assert.ok(expected.includes(`ci / Verify serialized server suites (${shard}/9)`), String(shard));
  for (const name of ["review", "maintenance upgrade toolkit", "ci / verify", "ci / e2e", "ci / e2e shard (8/8)", "ci / General tests (server (12/12))"]) assert.ok(expected.includes(name), name);
  // `ci / verify` is an aggregate that does not cover the serialized shards.
  const verify = committedGraph.aggregates.find((entry) => entry.check === "ci / verify");
  assert.ok(!verify.needs.some((name) => name.includes("serialized")));
  assert.deepEqual([...registry.requiredCiJobs].sort(), [...expected].sort());
});

// --- Admission against the real graph ------------------------------------

const verifiedGraph = { status: "pass", detail: "test", graph: committedGraph };
const allSucceeded = () => names(committedGraph).map((name) => ({ name, status: "completed", conclusion: "success", headSha: CAND }));
const ciGate = ({ jobs = allSucceeded(), reg = registry, graph = verifiedGraph, headSha = CAND } = {}) =>
  evaluateAdmission({ registry: reg, candidate: { sha: CAND, upstreamSha: reg.firstCandidateUpstreamSha, authority: "FAC-760" }, ci: { headSha, jobsComplete: true, jobs }, ciGraph: graph })
    .gates.find((entry) => entry.id === "candidate-ci");

test("R4: complete success on every expected lane passes the CI gate", () => {
  const result = ciGate();
  assert.equal(result.status, "pass", result.detail);
});

test("R4: removing any single expected lane fails, including each serialized shard and review", () => {
  for (const name of names(committedGraph)) {
    const result = ciGate({ jobs: allSucceeded().filter((job) => job.name !== name) });
    assert.equal(result.status, "fail", name);
    assert.match(result.detail, /required checks absent/, name);
  }
});

test("R4: the earlier nine-name required set is rejected for omitting expected lanes", () => {
  const short = { ...registry, requiredCiJobs: ["ci / Select trusted runner", "ci / policy", "ci / Typecheck + Release Registry", "ci / Build", "ci / Docker context integrity", "ci / Canary Dry Run", "ci / e2e", "ci / verify", "maintenance upgrade toolkit"] };
  // Even when only those nine checks were reported, which once passed.
  const nineOnly = allSucceeded().filter((job) => short.requiredCiJobs.includes(job.name));
  for (const jobs of [nineOnly, allSucceeded()]) {
    const result = ciGate({ reg: short, jobs });
    assert.equal(result.status, "fail");
    assert.match(result.detail, /omits expected lanes: .*Verify serialized server suites \(1\/9\).*review/);
  }
});

test("R4: failed, skipped, pending and wrong-head lanes never pass", () => {
  const withLane = (patch) => allSucceeded().map((job) => (job.name === "ci / Verify serialized server suites (1/9)" ? { ...job, ...patch } : job));
  assert.equal(ciGate({ jobs: withLane({ conclusion: "failure" }) }).status, "fail");
  assert.equal(ciGate({ jobs: withLane({ conclusion: "skipped" }) }).status, "fail");
  assert.equal(ciGate({ jobs: withLane({ status: "in_progress", conclusion: null }) }).status, "unknown");
  assert.equal(ciGate({ jobs: withLane({ headSha: "d".repeat(40) }) }).status, "fail");
  assert.equal(ciGate({ jobs: allSucceeded().map((job) => (job.name === "review" ? { ...job, conclusion: "failure" } : job)) }).status, "fail");
});

test("R4: an unverified, stale or unreviewed graph never passes", () => {
  assert.equal(ciGate({ graph: null }).status, "unknown");
  assert.equal(ciGate({ graph: { status: "unknown", detail: "candidate workflows differ" } }).status, "unknown");
  const otherGraph = { ...committedGraph, checks: committedGraph.checks.filter((check) => check.name !== "review") };
  assert.match(ciGate({ graph: { status: "pass", graph: otherGraph } }).detail, /registry reviewed CI graph/);
  const extra = { ...registry, requiredCiJobs: [...registry.requiredCiJobs, "not a lane"] };
  assert.match(ciGate({ reg: extra }).detail, /not produced by the reviewed graph/);
});
