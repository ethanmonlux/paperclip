import assert from "node:assert/strict";
import test from "node:test";
import { budgetCandidates, focusGraph } from "./select-tests.mjs";
import { refineTestPlan } from "./test-selection-plan.mjs";
import { typecheckArguments } from "./affected-packages.mjs";

// Routine pushes (Staple, STA-223) run the tests known to be affected. The opaque remainder the
// complete selection keeps is counted and left to the nightly certification.
const graph = (overrides = {}) => ({
  project: "@paperclipai/server", isolated: true, setupChanged: false,
  inventory: ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts", "e.test.ts"],
  related: ["a.test.ts"], inputRelated: ["b.test.ts"], direct: ["a.test.ts"],
  alwaysRun: ["a.test.ts", "c.test.ts", "d.test.ts"],
  retentionReasons: { "a.test.ts": { module: "x.ts", reasons: ["builtin node:fs"] },
    "c.test.ts": { module: "x.ts", reasons: ["builtin node:fs"] }, "d.test.ts": { module: "d.test.ts", reasons: ["opaque dependency express"] } },
  selected: ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts"], ...overrides,
});

test("a focused graph keeps related, input-related and changed tests and defers the opaque remainder", () => {
  const focused = focusGraph(graph(), ["src/x.ts"]);
  assert.deepEqual(focused.selected, ["a.test.ts", "b.test.ts"]);
  assert.deepEqual(focused.deferred, ["c.test.ts", "d.test.ts"]);
  // An opaque test that the change itself edits is not deferred.
  assert.deepEqual(focusGraph(graph(), ["d.test.ts"]).selected, ["a.test.ts", "b.test.ts", "d.test.ts"]);
  // A test kept for a reason other than an opaque import stays selected.
  const unexplained = graph({ alwaysRun: ["c.test.ts", "e.test.ts"], selected: ["a.test.ts", "c.test.ts", "e.test.ts"] });
  assert.deepEqual(focusGraph(unexplained, []).selected, ["a.test.ts", "e.test.ts"]);
});

test("a changed setup dependency or a shared worker still selects the whole project", () => {
  for (const overrides of [{ setupChanged: true }, { isolated: false }]) {
    const focused = focusGraph(graph(overrides), ["src/x.ts"]);
    assert.deepEqual(focused.selected, graph().selected);
    assert.deepEqual(focused.deferred, []);
  }
});

test("an empty focused selection schedules no test lane and keeps the chat lane's own ownership", () => {
  const chat = { group: "general-chat", group_label: "chat (1/3)", shard_index: 0, shard_count: 3, task: "ci:chat" };
  const server = { group: "general-server-without-chat", group_label: "server (1/12)", shard_index: 0, shard_count: 12, task: "ci:server" };
  const serialized = { shard_index: 0, shard_count: 9, shard_label: "1/9", task: "ci:serialized" };
  const lane = (entries) => ({ run: true, matrix: { include: entries }, selected: entries.length, proposed: entries.length, total: entries.length });
  const plan = { version: 1, jobs: { general_tests: lane([server]), verify_serialized_server: lane([serialized]) } };
  const focus = { changed: 0 };
  const empty = refineTestPlan({ plan, head: "a".repeat(40), owners: {}, graphs: [], empty: true, focus });
  assert.equal(empty.plan.jobs.general_tests.run, false);
  assert.equal(empty.plan.jobs.verify_serialized_server.run, false);
  assert.deepEqual(empty.manifest.lanes, {});
  assert.equal(empty.plan.testSelection.focus, focus);
  assert.deepEqual(empty.plan.testSelection.stats.map((entry) => entry.jobs), [0, 0]);
  const withChat = refineTestPlan({ plan: { ...plan, jobs: { ...plan.jobs, general_tests: lane([server, chat]) } },
    head: "a".repeat(40), owners: {}, graphs: [], empty: true, focus });
  assert.deepEqual(withChat.plan.jobs.general_tests.matrix.include, [chat]);
});

test("the affected-package typecheck names the changed packages with their dependents, or every package", () => {
  assert.equal(typecheckArguments({ run: false, all: null, packages: [] }), null);
  assert.equal(typecheckArguments(undefined), null);
  assert.deepEqual(typecheckArguments({ run: true, all: null, packages: ["packages/adapter-utils", "server"] }),
    ["--filter", "...{packages/adapter-utils}", "--filter", "...{server}", "--workspace-concurrency=1", "--if-present", "run", "typecheck"]);
  assert.deepEqual(typecheckArguments({ run: true, all: "package.json", packages: ["server"] }),
    ["-r", "--workspace-concurrency=1", "--if-present", "run", "typecheck"]);
  assert.throws(() => typecheckArguments({ run: true, all: null, packages: [] }), /names no package/);
  for (const directory of ["../outside", "server}{..", "a b", "$(id)"]) {
    assert.throws(() => typecheckArguments({ run: true, all: null, packages: [directory] }), /Invalid package directory/);
  }
});

test("budget pruning keeps the nearest tests and never prunes a project that a setup change invalidates", () => {
  const server = { project: "@paperclipai/server", isolated: true, setupChanged: false, inputRelated: ["fixture.test.ts"],
    direct: ["heartbeat.test.ts", "heartbeat-queue.test.ts", "routes/issues.test.ts"],
    selected: ["far.test.ts", "fixture.test.ts", "heartbeat-queue.test.ts", "heartbeat.test.ts", "routes/issues.test.ts", "services/edited.test.ts"] };
  const ui = { project: "@paperclipai/ui", isolated: true, setupChanged: true, inputRelated: [], direct: [],
    selected: ["a.test.tsx", "b.test.tsx", "c.test.tsx"] };
  const shared = { ...ui, project: "@paperclipai/shared", setupChanged: false, isolated: false };
  const changed = ["services/heartbeat.ts", "services/edited.test.ts", "ui/vitest.setup.ts"];
  const candidates = budgetCandidates([server, ui, shared], changed, ["services/heartbeat.ts", "services/edited.test.ts"]);
  assert.deepEqual(candidates.map((candidate) => candidate.graphs[0].selected), [
    ["fixture.test.ts", "heartbeat-queue.test.ts", "heartbeat.test.ts", "routes/issues.test.ts", "services/edited.test.ts"],
    ["heartbeat-queue.test.ts", "heartbeat.test.ts", "services/edited.test.ts"],
    ["services/edited.test.ts"],
    [],
  ]);
  for (const candidate of candidates) {
    assert.deepEqual(candidate.graphs[1].selected, ui.selected, `${candidate.label}: a setup-invalidated project runs whole`);
    assert.deepEqual(candidate.graphs[2].selected, shared.selected, `${candidate.label}: a shared-worker project runs whole`);
  }
  assert.equal(candidates.at(-1).label, "no test");
});
