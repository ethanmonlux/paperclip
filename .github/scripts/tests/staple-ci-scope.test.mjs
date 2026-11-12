import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { matchesGlob } from "node:path";
import test from "node:test";
import { planTasks } from "../ci-plan.mjs";
import { scopePlan, scopeSummary, validateScope } from "../staple-ci-scope.mjs";

// STA-223: holds the Staple CI scope map. Every workspace package must be classified, every task
// matrix job must have a rule, a routine push plans only light checks, and a complete suite is
// complete.
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
  forceReason: options.forceReason ?? null });
const counts = (plan) => Object.fromEntries(Object.entries(plan.jobs).map(([job, lane]) => [job, lane.selected]));
const NONE = Object.fromEntries(Object.keys(lanes).map((job) => [job, 0]));
// Suites that only the nightly certification (or the full-ci label) runs.
const CERTIFICATION = ["typecheck_release_registry", "build", "e2e_shards", "verify_runner_e2e_support", "canary_dry_run"];

test("the routing step appends exactly the fork inputs this test plans with", () => {
  assert.match(routing, /config\.globalDependencies\.push\("\*\*\/pnpm-lock\.yaml", "\*\*\/package-lock\.json", "\*\*\/yarn\.lock",\s*"\*\*\/Cargo\.lock", "\*\*\/Cargo\.toml", "packages\/db\/\*\*"\);/);
  assert.match(routing, /staple-ci-scope\.json/);
});

test("every task matrix job has a scope rule, and the map validates", () => {
  validateScope(scope, lanes);
  assert.throws(() => validateScope(scope, { ...lanes, new_suite: [{ task: "ci:server" }] }), /must match the task matrix/);
  assert.throws(() => validateScope({ ...scope, jobs: { ...scope.jobs, e2e_shards: ["no-such-set"] } }, lanes), /Invalid scope rule for e2e_shards/);
  assert.throws(() => validateScope({ ...scope, jobs: { ...scope.jobs, general_tests: { groups: { "general-nope": ["chat"] } } } }, lanes),
    /Invalid scope rule for general_tests/);
  assert.throws(() => validateScope({ ...scope, jobs: { ...scope.jobs, build: "always" } }, lanes), /Invalid scope rule for build/);
  assert.throws(() => validateScope({ ...scope, routine: { ...scope.routine, maxTestJobs: 0 } }, lanes), /maxTestJobs/);
  assert.throws(() => validateScope({ ...scope, routine: { ...scope.routine, typecheckAllPaths: [] } }, lanes), /typecheckAllPaths/);
  assert.throws(() => validateScope({ ...scope, version: 1 }, lanes), /Unsupported/);
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

test("a routine push never plans a certification suite, whatever it changes", () => {
  assert.deepEqual(Object.entries(scope.jobs).filter(([, rule]) => rule === "certification").map(([job]) => job).sort(), [...CERTIFICATION].sort());
  for (const paths of [["ui/src/components/Sidebar.tsx"], ["server/src/services/heartbeat/queue.ts"], ["server/src/routes/issues.ts"],
    ["packages/shared/src/validators/issue.ts"], ["packages/db/src/schema/issues.ts"], ["cli/src/index.ts"], ["Dockerfile"],
    ["packages/paperclip-runner/runner/crates/runner-core/src/lib.rs"], ["pnpm-lock.yaml", "package.json"], [".github/workflows/pr-trusted.yml"],
    ["brand-new-top-level/file.ts"], ["doc/plans/2026-11-12-example.md"]]) {
    const plan = scoped(paths);
    assert.equal(plan.staple.scope, "routine", paths.join());
    assert.equal(plan.forceReason, null, paths.join());
    assert.equal(plan.staple.focused, true);
    assert.equal(plan.staple.vitestSelection, true);
    for (const job of CERTIFICATION) {
      assert.equal(plan.jobs[job].run, false, `${job} for ${paths.join()}`);
      assert.equal(plan.staple.gates[job], "nightly certification");
    }
    assert.deepEqual(plan.staple.deferred.sort(), [...CERTIFICATION].sort());
  }
});

test("merge-gate change (six server files): the server test lanes, for file selection, and a server typecheck", () => {
  const files = ["policy.test.ts", "policy.ts", "service.test.ts", "service.ts", "wiring.test.ts", "wiring.ts"]
    .map((file) => `server/src/services/merge-gate/${file}`);
  const plan = scoped(files);
  // These lanes are the candidates file selection narrows to the focused tests (two jobs for this diff).
  assert.deepEqual(counts(plan), { ...NONE, general_tests: 15, verify_serialized_server: 9 });
  assert.ok(!plan.jobs.general_tests.matrix.include.some((entry) => entry.group === "general-chat"));
  assert.deepEqual(plan.staple.affected, { run: true, all: null, packages: ["server"] });
  assert.deepEqual(plan.staple.unplanned, []);
  assert.equal(plan.staple.maxTestJobs, scope.routine.maxTestJobs);
  // Unscoped, the same diff scheduled every e2e shard, the build, the canary and the Runner support suite.
  assert.equal(unscoped(files).jobs.e2e_shards.selected, 8);
});

test("launcher change (one adapter-utils source and its test): its package and dependents, no heavy suite", () => {
  const plan = scoped(["packages/adapter-utils/src/github-launcher.test.ts", "packages/adapter-utils/src/github-launcher.ts"]);
  assert.deepEqual(plan.staple.affected, { run: true, all: null, packages: ["packages/adapter-utils"] });
  assert.equal(plan.jobs.verify_paperclip_runner.run, false);
  assert.ok(plan.jobs.general_tests.run && plan.jobs.verify_serialized_server.run);
  assert.ok(!plan.jobs.general_tests.matrix.include.some((entry) => entry.group === "general-chat"));
});

test("documentation and policy-only changes run the policy job alone", () => {
  const files = ["scripts/staple/staple-nightly-upgrade.sh", "scripts/__tests__/staple-nightly-certified.test.mjs",
    "scripts/__tests__/fixtures/staple-certify-red/actions_runs_42762197624.json", ".github/staple-ci-scope.json"];
  assert.match(unscoped(files).forceReason, /Global CI input changed: scripts\/staple/);
  const plan = scoped(files);
  assert.deepEqual(counts(plan), NONE);
  assert.deepEqual(plan.staple.policyOnly, files);
  assert.equal(plan.staple.affected.run, false);
  assert.match(plan.staple.upstreamForceReason, /scripts\/staple/);
  const docs = scoped(["doc/plans/2026-11-10-example.md", "doc/observability.md", "README.md"]);
  assert.deepEqual(counts(docs), NONE);
  assert.equal(docs.staple.affected.run, false);
  assert.deepEqual(docs.staple.unplanned, ["doc/observability.md", "README.md"]);
  // With a server change beside them, only the server change decides the suites.
  assert.deepEqual(counts(scoped([...files, "server/src/services/merge-gate/policy.ts"])), counts(scoped(["server/src/services/merge-gate/policy.ts"])));
});

test("broad, configuration and upstream-sync changes stay light and say what they leave to the certification", () => {
  const config = scoped(["package.json", "pnpm-lock.yaml", "tsconfig.base.json", ".github/workflows/pr-trusted.yml", "scripts/ci/select-tests.mjs"]);
  assert.deepEqual(counts(config), NONE);
  assert.deepEqual(config.staple.affected, { run: true, all: "package.json", packages: [] });
  assert.deepEqual(config.staple.unplanned, ["package.json", "pnpm-lock.yaml", "tsconfig.base.json", ".github/workflows/pr-trusted.yml", "scripts/ci/select-tests.mjs"]);
  assert.match(config.staple.upstreamForceReason, /Global CI input changed/);
  assert.match(scopeSummary(config), /Inputs no routine suite owns, left to the certification: package\.json/);
  assert.match(scopeSummary(config), /Affected packages \(typecheck\): every package \(package\.json changed\)/);
  // An upstream sync is one more routine push: the branch name no longer selects the complete suite.
  const sync = ["package.json", "pnpm-lock.yaml", "server/src/app.ts", "ui/src/App.tsx", "packages/shared/src/api.ts",
    "packages/db/src/schema/issues.ts", "cli/src/index.ts", "Dockerfile", "doc/SPEC.md", "packages/paperclip-runner/src/index.ts"];
  const plan = scoped(sync);
  assert.equal(plan.staple.scope, "routine");
  for (const job of CERTIFICATION) assert.equal(plan.jobs[job].run, false, job);
  assert.equal(plan.staple.affected.all, "package.json");
  assert.deepEqual(plan.staple.affected.packages, ["cli", "packages/db", "packages/paperclip-runner", "packages/shared", "server", "ui"]);
  // Suites that test a changed package's own source still run with it.
  assert.equal(plan.jobs.docker_context_integrity.selected, 1);
  assert.ok(plan.jobs.verify_paperclip_runner.selected > 0);
  assert.equal(scope.fullSuiteBranches, undefined);
});

test("package-owned suites run only with their own paths", () => {
  const runner = scoped(["packages/paperclip-runner/runner/crates/runner-core/src/lib.rs"]);
  assert.ok(runner.jobs.verify_paperclip_runner.matrix.include.some((entry) => entry.task === "ci:runner-rust"));
  assert.deepEqual(runner.staple.affected.packages, ["packages/paperclip-runner"]);
  assert.equal(scoped(["server/src/services/native-runtime/plugin-runner-probe.ts"]).jobs.verify_paperclip_runner.run, false);
  assert.equal(scoped(["Dockerfile"]).jobs.docker_context_integrity.selected, 1);
  assert.equal(scoped(["server/src/app.ts"]).jobs.docker_context_integrity.run, false);
  const provider = scoped(["packages/plugins/sandbox-providers/daytona/src/plugin.ts"]);
  assert.equal(provider.jobs.sandbox_provider_tests.selected, 1);
  const chat = scoped(["server/src/services/chat-channels/slack.ts"]);
  assert.ok(chat.jobs.general_tests.matrix.include.some((entry) => entry.group === "general-chat"));
  assert.match(scoped(["server/src/services/heartbeat/queue.ts"]).staple.gates.general_tests, /general-chat: no change under chat/);
});

test("a complete suite selects every lane: labels, stacks, other modes and a missing diff", () => {
  const complete = (plan, reason) => {
    assert.equal(plan.staple.scope, "full");
    assert.match(plan.staple.reason, reason);
    assert.match(plan.forceReason, reason, "a force reason keeps file selection and the task cache away from a complete suite");
    assert.equal(plan.staple.vitestSelection, false);
    assert.equal(plan.staple.focused, false);
    assert.equal(plan.staple.affected.run, false);
    for (const [job, lane] of Object.entries(plan.jobs)) {
      assert.equal(lane.selected, lane.total, `${job}: ${plan.staple.reason}`);
      assert.deepEqual(lane.matrix.include, lanes[job], job);
    }
  };
  // The narrowest diffs: a path-scoped plan would omit most lanes (FAC-894).
  for (const paths of [["ui/src/a.tsx"], ["doc/plans/2026-11-12-example.md"], ["scripts/staple/README.md"]]) {
    complete(scoped(paths, { forceReason: "Full suite requested by label" }), /requested by label/);
    complete(scopePlan({ plan: unscoped(paths), scope, config, lanes, forceReason: "Stack verification includes lower pull requests" }), /Stack verification/);
  }
  assert.ok(unscoped(["ui/src/a.tsx"]).jobs.verify_serialized_server.selected === 0, "the unscoped plan for this diff is not complete");
  complete(scopePlan({ plan: { ...unscoped(["ui/src/a.tsx"]), mode: "shadow" }, scope, config, lanes }), /CI mode shadow/);
  complete(scopePlan({ plan: { ...unscoped(["ui/src/a.tsx"]), changed: [] }, scope, config, lanes }), /Missing diff/);
  assert.equal(scopePlan({ plan: null, scope, config, lanes }), null);
});

test("every published plan keeps a non-empty matrix and a boolean decision for each job", () => {
  for (const paths of [["ui/src/a.tsx"], ["server/src/services/merge-gate/policy.ts"], ["scripts/staple/x.sh"],
    ["server/src/services/heartbeat/queue.ts"], [".github/workflows/pr-trusted.yml"], ["doc/a.md"]]) {
    for (const plan of [scoped(paths), scoped(paths, { forceReason: "Full suite requested by label" })]) {
      assert.equal(plan.version, 1);
      assert.deepEqual(plan.changed, paths);
      for (const [job, lane] of Object.entries(plan.jobs)) {
        assert.equal(typeof lane.run, "boolean", job);
        assert.equal(lane.run, lane.selected > 0, job);
        assert.ok(lane.matrix.include.length > 0, `${job} matrix must not be empty`);
      }
      assert.equal(typeof plan.staple.affected.run, "boolean");
      assert.match(scopeSummary(plan), /### Staple CI scope/);
    }
  }
});
