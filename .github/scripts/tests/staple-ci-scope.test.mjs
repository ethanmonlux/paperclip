import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { matchesGlob } from "node:path";
import test from "node:test";
import { planTasks } from "../ci-plan.mjs";
import { scopePlan, scopeSummary, validateScope } from "../staple-ci-scope.mjs";

// STA-223: holds the Staple PR scope map. Every workspace package must be classified, every task
// matrix job must have a rule, and typical PRs plan only the suites that cover their changes.
const root = new URL("../../../", import.meta.url);
const read = (file) => readFileSync(new URL(file, root), "utf8");
const scope = JSON.parse(read(".github/staple-ci-scope.json"));
const lanes = JSON.parse(read(".github/ci-task-matrix.json"));
const routing = read(".github/workflows/ci-routing.yml");

// The fork's routing step appends these inputs to its copy of turbo.json before planning.
const FORK_GLOBALS = ["**/pnpm-lock.yaml", "**/package-lock.json", "**/yarn.lock", "**/Cargo.lock", "**/Cargo.toml", "packages/db/**"];
const config = JSON.parse(read("turbo.json"));
config.globalDependencies.push(...FORK_GLOBALS);

const unscoped = (paths, options = {}) => planTasks({ config, lanes, paths, mode: options.mode ?? "enabled", forceReason: options.forceReason ?? null });
const scoped = (paths, options = {}) => scopePlan({ plan: unscoped(paths, options), scope, config, lanes,
  headRef: options.headRef ?? "sta-999-example", forceReason: options.forceReason ?? null });
const counts = (plan) => Object.fromEntries(Object.entries(plan.jobs).map(([job, lane]) => [job, lane.selected]));
const NONE = Object.fromEntries(Object.keys(lanes).map((job) => [job, 0]));
const ALWAYS = { ...NONE, typecheck_release_registry: 1, build: 1 };

test("the routing step appends exactly the fork inputs this test plans with", () => {
  assert.match(routing, /config\.globalDependencies\.push\("\*\*\/pnpm-lock\.yaml", "\*\*\/package-lock\.json", "\*\*\/yarn\.lock",\s*"\*\*\/Cargo\.lock", "\*\*\/Cargo\.toml", "packages\/db\/\*\*"\);/);
  assert.match(routing, /staple-ci-scope\.json/);
  assert.match(routing, /EVENT_HEAD_REF: \$\{\{ github\.head_ref \}\}/);
});

test("every task matrix job has a scope rule, and the map validates", () => {
  validateScope(scope, lanes);
  assert.throws(() => validateScope(scope, { ...lanes, new_suite: [{ task: "ci:server" }] }), /must match the task matrix/);
  assert.throws(() => validateScope({ ...scope, jobs: { ...scope.jobs, e2e_shards: ["no-such-set"] } }, lanes), /Invalid scope rule for e2e_shards/);
  assert.throws(() => validateScope({ ...scope, jobs: { ...scope.jobs, general_tests: { groups: { "general-nope": ["chat"] } } } }, lanes),
    /Invalid scope rule for general_tests/);
  assert.throws(() => validateScope({ ...scope, version: 2 }, lanes), /Unsupported/);
});

function workspacePackages() {
  const patterns = `\n${read("pnpm-workspace.yaml")}`.split("\npackages:\n")[1].split(/\n\S/)[0].split("\n")
    .map((line) => line.match(/^\s+-\s+"?([^"#\s]+)"?/)?.[1]).filter(Boolean);
  const include = patterns.filter((pattern) => !pattern.startsWith("!"));
  const exclude = patterns.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
  const dirs = new Set();
  for (const pattern of include) {
    if (!pattern.endsWith("/*")) { dirs.add(pattern); continue; }
    const parent = pattern.slice(0, -2);
    for (const entry of readdirSync(new URL(`${parent}/`, root), { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(new URL(`${parent}/${entry.name}/package.json`, root))) dirs.add(`${parent}/${entry.name}`);
    }
  }
  // Excluded from the workspace so they stay standalone, but still packages the scope must classify.
  for (const pattern of exclude) {
    const parent = pattern.replace(/\/\*\*$/, "");
    if (pattern.endsWith("/**")) {
      for (const entry of readdirSync(new URL(`${parent}/`, root), { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(new URL(`${parent}/${entry.name}/package.json`, root))) dirs.add(`${parent}/${entry.name}`);
      }
    } else dirs.add(parent);
  }
  return [...dirs].sort();
}

test("every package is classified explicitly, so a new package cannot fall outside the map", () => {
  const packages = workspacePackages();
  assert.ok(packages.length > 30, `found ${packages.length} packages`);
  const keys = Object.keys(scope.packages);
  const owner = (dir) => keys.filter((key) => key === dir || (key.endsWith("/*") && matchesGlob(dir, key)));
  for (const dir of packages) {
    assert.equal(owner(dir).length, 1, `${dir} must be classified once in .github/staple-ci-scope.json "packages"`);
  }
  for (const key of keys) assert.ok(packages.some((dir) => owner(dir).includes(key)), `stale package key ${key}`);
  // Each classification is what the path sets really do with the package's source.
  const sets = Object.keys(scope.pathSets);
  for (const dir of packages) {
    const probe = `${dir}/src/__staple_scope_probe__.ts`;
    const actual = sets.filter((name) => scope.pathSets[name].some((glob) => matchesGlob(probe, glob)));
    assert.deepEqual(actual, [...scope.packages[owner(dir)[0]]].sort(), `${dir} triggers ${actual.join(", ") || "no heavy suite"}`);
  }
});

test("UI-only changes run build, typecheck and the UI tests", () => {
  const plan = scoped(["ui/src/components/Sidebar.tsx", "ui/src/components/Sidebar.test.tsx"]);
  assert.deepEqual(counts(plan), { ...ALWAYS, general_tests: 2 });
  assert.ok(plan.jobs.general_tests.matrix.include.every((entry) => entry.group === "general-workspaces-a"));
  assert.equal(plan.forceReason, null);
  assert.equal(plan.staple.scope, "change-scoped");
  assert.equal(plan.staple.vitestSelection, true);
  assert.match(plan.staple.gates.e2e_shards, /no change under lifecycle/);
  // Unscoped, the same diff scheduled every e2e shard, Docker, canary and the Runner support suite.
  assert.equal(unscoped(["ui/src/components/Sidebar.tsx"]).jobs.e2e_shards.selected, 8);
});

test("server changes run the server suites, and e2e only for lifecycle, heartbeat, routing or the API contract", () => {
  const service = scoped(["server/src/services/merge-gate/policy.ts", "server/src/services/merge-gate/policy.test.ts"]);
  assert.deepEqual(counts(service), { ...ALWAYS, general_tests: 15, verify_serialized_server: 9 });
  assert.ok(!service.jobs.general_tests.matrix.include.some((entry) => entry.group === "general-chat"));
  for (const file of ["server/src/services/heartbeat/queue.ts", "server/src/services/capability-routing.ts", "server/src/routes/issues.ts",
    "packages/shared/src/validators/issue.ts", "packages/adapter-utils/src/index.ts"]) {
    const plan = scoped([file]);
    assert.equal(plan.jobs.e2e_shards.selected, 8, file);
    assert.ok(plan.jobs.general_tests.matrix.include.some((entry) => entry.group === "general-chat"), file);
  }
  // A shared type that is not API contract runs the server suites without e2e.
  const sharedType = scoped(["packages/shared/src/staple-console.ts"]);
  assert.equal(sharedType.forceReason, null);
  assert.equal(sharedType.jobs.e2e_shards.selected, 0);
  assert.ok(sharedType.jobs.general_tests.selected > 0 && sharedType.jobs.verify_serialized_server.selected > 0);
});

test("Runner, Docker and release paths run their own suites", () => {
  const runner = scoped(["packages/paperclip-runner/runner/crates/runner-core/src/lib.rs"]);
  assert.ok(runner.jobs.verify_paperclip_runner.matrix.include.some((entry) => entry.task === "ci:runner-rust"));
  assert.equal(runner.jobs.verify_runner_e2e_support.selected, 1);
  assert.equal(runner.jobs.e2e_shards.selected, 0);
  assert.equal(scoped(["cli/src/index.ts"]).jobs.canary_dry_run.selected, 1);
  assert.equal(scoped(["server/src/services/native-runtime/plugin-runner-probe.ts"]).jobs.verify_paperclip_runner.selected, 5);
});

test("policy-only changes run only build, typecheck and policy, even though scripts/** is a global input", () => {
  const files = ["scripts/staple/staple-nightly-upgrade.sh", "scripts/__tests__/staple-nightly-certified.test.mjs",
    "scripts/__tests__/fixtures/staple-certify-red/actions_runs_42762197624.json", ".github/staple-ci-scope.json"];
  assert.match(unscoped(files).forceReason, /Global CI input changed: scripts\/staple/);
  const plan = scoped(files);
  assert.deepEqual(counts(plan), ALWAYS);
  assert.deepEqual(plan.staple.policyOnly, files);
  assert.match(plan.staple.upstreamForceReason, /scripts\/staple/);
  // With a server change beside them, only the server change decides the suites.
  assert.deepEqual(counts(scoped([...files, "server/src/services/merge-gate/policy.ts"])), counts(scoped(["server/src/services/merge-gate/policy.ts"])));
  assert.deepEqual(counts(scoped(["doc/plans/2026-11-10-example.md"])), ALWAYS);
});

test("global inputs, unknown paths, labels, stacks, other modes and upstream syncs keep the complete suite", () => {
  const complete = (plan, reason) => {
    assert.equal(plan.staple.scope, "full");
    assert.match(plan.staple.reason, reason);
    assert.equal(plan.staple.vitestSelection, false);
    assert.ok(Object.values(plan.jobs).every((lane) => lane.selected === lane.total), plan.staple.reason);
  };
  complete(scoped([".github/workflows/pr-trusted.yml"]), /Global CI input changed: \.github\/workflows\/pr-trusted\.yml/);
  complete(scoped(["pnpm-lock.yaml"]), /Global CI input changed/);
  complete(scoped(["packages/db/src/schema/issues.ts"]), /packages\/db/);
  complete(scoped(["brand-new-top-level/file.ts"]), /Unclassified path/);
  complete(scoped(["ui/src/a.tsx"], { forceReason: "Full suite requested by label" }), /requested by label/);
  complete(scoped(["ui/src/a.tsx"], { mode: "shadow" }), /CI mode shadow/);
  const sync = scoped(["ui/src/a.tsx"], { headRef: "staple/upstream-sync-2026-11-10" });
  assert.equal(sync.staple.scope, "full");
  assert.match(sync.staple.reason, /Full-suite branch staple\/upstream-sync-2026-11-10/);
  assert.equal(sync.staple.vitestSelection, false);
  // An upstream sync keeps the plan it already had: complete when its diff is broad.
  assert.deepEqual(counts(sync), counts(unscoped(["ui/src/a.tsx"])));
  assert.equal(scopePlan({ plan: null, scope, config, lanes }), null);
});

test("every published plan keeps a non-empty matrix and a boolean decision for each job", () => {
  for (const paths of [["ui/src/a.tsx"], ["server/src/services/merge-gate/policy.ts"], ["scripts/staple/x.sh"],
    ["server/src/services/heartbeat/queue.ts"], [".github/workflows/pr-trusted.yml"], ["doc/a.md"]]) {
    const plan = scoped(paths);
    assert.equal(plan.version, 1);
    assert.deepEqual(plan.changed, paths);
    for (const [job, lane] of Object.entries(plan.jobs)) {
      assert.equal(typeof lane.run, "boolean", job);
      assert.equal(lane.run, lane.selected > 0, job);
      assert.ok(lane.matrix.include.length > 0, `${job} matrix must not be empty`);
    }
    assert.match(scopeSummary(plan), /### Staple PR scope/);
  }
});
