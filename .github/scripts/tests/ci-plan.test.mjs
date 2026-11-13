import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { comparisonPaths, planTasks } from "../ci-plan.mjs";
import { mergeDiff } from "../ci-diff.mjs";
import { changedDigest } from "../staple-ci-scope.mjs";

const root = new URL("../../../", import.meta.url);
const config = JSON.parse(readFileSync(new URL("turbo.json", root), "utf8"));
const lanes = JSON.parse(readFileSync(new URL(".github/ci-task-matrix.json", root), "utf8"));
const plan = (paths, options = {}) => planTasks({ config, lanes, paths, ...options });
const selected = (result, job) => result.jobs[job].run;
const selectedTasks = (result) => new Set(Object.values(result.jobs).filter((job) => job.run)
  .flatMap((job) => job.matrix.include.map((entry) => entry.task)));

test("trusted workflow fallbacks preserve every declared partition and command", () => {
  const workflow = readFileSync(new URL(".github/workflows/pr-trusted.yml", root), "utf8");
  for (const [job, entries] of Object.entries(lanes)) {
    const block = workflow.split(`\n  ${job}:\n`)[1].split(/\n  [a-z0-9_]+:\n/)[0];
    const normalized = block.replaceAll("(needs.test_selection.outputs.plan || needs.gate.outputs.plan)", "needs.gate.outputs.plan");
    assert.ok(normalized.includes(`fromJSON(needs.gate.outputs.plan).jobs.${job}.run`), job);
    if (!block.includes("      matrix:")) { assert.equal(entries.length, 1); continue; }
    const fallback = block.match(/matrix:.*\|\| '(.*)'\) \}\}/)?.[1];
    assert.ok(fallback, `${job}: missing full fallback`);
    assert.deepEqual(JSON.parse(fallback), { include: entries }, job);
  }
});

test("a UI component retains browser and build coverage without unrelated server/Rust jobs", () => {
  const result = plan(["ui/src/components/Sidebar.tsx"]);
  assert.equal(selected(result, "build"), true);
  assert.equal(selected(result, "e2e_shards"), true);
  assert.equal(selected(result, "verify_serialized_server"), false);
  // The Runner support suite imports UI modules and checks that catalog-listed
  // UI files stay tracked, so UI source changes are its inputs too.
  assert.deepEqual([...selectedTasks(result)].filter((task) => /server|chat|runner/.test(task)), ["ci:runner-e2e-support"]);
  assert.equal(result.jobs.general_tests.selected, 2);
});

test("source inspected across package boundaries selects its consumers", () => {
  for (const file of ["ui/src/lib/issue-execution-policy.ts", "ui/src/index.css", "ui/src/pages/CompanyExport.tsx",
    "ui/src/components/MarkdownBody.tsx"]) {
    const tasks = selectedTasks(plan([file]));
    assert.ok(tasks.has("ci:server"), file);
    assert.ok(tasks.has("ci:runner-vitest"), file);
  }
  assert.ok(selectedTasks(plan(["ui/public/app-logos/example.svg"])).has("ci:workspaces-b"));
});

test("repository-wide guidance guards run uncached for every scanned UI file type", () => {
  const source = readFileSync(new URL("server/src/__tests__/cli-invocation-safety.test.ts", root), "utf8");
  const extensions = [...source.split("const SCAN_EXTENSIONS = new Set([")[1].split("]);")[0].matchAll(/"(\.[a-z]+)"/g)]
    .map((match) => match[1]);
  assert.ok(extensions.length > 0);
  for (const extension of extensions) {
    for (const folder of ["ui/src/components", "ui/src/pages", "ui/src/hooks", "ui/public"]) {
      assert.ok(plan([`${folder}/guidance${extension}`]).jobs.typecheck_release_registry.run);
    }
  }
  assert.equal(config.tasks["//#ci:typecheck"].cache, false);
  const workflow = readFileSync(new URL(".github/workflows/pr-trusted.yml", root), "utf8");
  const job = workflow.split("\n  typecheck_release_registry:\n")[1].split("\n  general_tests:\n")[0];
  assert.match(job, /- name: Verify repository-wide CLI guidance safety\n        run: pnpm exec vitest run --project @paperclipai\/server server\/src\/__tests__\/cli-invocation-safety.test.ts/);
  assert.ok(!job.includes("uses: ./.github/actions/run-ci-task"));
});

test("shared contracts, runtime prompts, protocol inputs and fixtures reach consumers", () => {
  const shared = selectedTasks(plan(["packages/shared/src/types/issue.ts"]));
  for (const task of ["ci:server", "ci:db", "ci:workspaces-a", "ci:workspaces-b", "ci:serialized", "ci:e2e"]) {
    assert.ok(shared.has(task), task);
  }
  assert.ok(selectedTasks(plan(["server/src/onboarding-assets/default/AGENTS.md"])).has("ci:runner-vitest"));
  assert.ok(selectedTasks(plan(["packages/paperclip-runner/protocol/schema.json"])).has("ci:runner-rust"));
  for (const file of ["tests/runner-e2e/fixtures/prompt.md", "scripts/run-vitest-stable.mjs", "pnpm-lock.yaml"]) {
    assert.ok(Object.values(plan([file]).jobs).every((job) => job.selected === job.total), file);
  }
});

test("sandbox provider tests run only for the providers, the plugin SDK, and what the SDK imports", () => {
  for (const file of ["packages/plugins/sandbox-providers/daytona/src/plugin.ts",
    "packages/plugins/sandbox-providers/cloudflare/bridge-template/src/index.ts",
    "packages/plugins/sdk/src/index.ts", "packages/shared/src/types/issue.ts"]) {
    assert.equal(selected(plan([file]), "sandbox_provider_tests"), true, file);
  }
  for (const file of ["server/src/index.ts", "ui/src/components/Sidebar.tsx", "cli/src/index.ts",
    "packages/paperclip-runner/src/index.ts", "packages/plugins/plugin-workspace-diff/src/worker.ts"]) {
    assert.equal(selected(plan([file]), "sandbox_provider_tests"), false, file);
  }
  // The provider lockfiles, the shared install workspace and the runner script are global inputs.
  for (const file of ["scripts/typecheck-sandbox-providers/pnpm-lock.yaml", "scripts/test-sandbox-providers.mjs",
    "packages/plugins/sandbox-providers/daytona/package.json"]) {
    assert.equal(selected(plan([file]), "sandbox_provider_tests"), true, file);
  }
  // The SDK depends on shared and nothing else in the workspace. A new dependency must join the inputs.
  const sdk = JSON.parse(readFileSync(new URL("packages/plugins/sdk/package.json", root), "utf8"));
  const workspace = Object.entries({ ...sdk.dependencies, ...sdk.peerDependencies })
    .filter(([, version]) => String(version).startsWith("workspace:")).map(([name]) => name);
  assert.deepEqual(workspace, ["@paperclipai/shared"]);
  const shared = JSON.parse(readFileSync(new URL("packages/shared/package.json", root), "utf8"));
  assert.deepEqual(Object.values({ ...shared.dependencies, ...shared.peerDependencies })
    .filter((version) => String(version).startsWith("workspace:")), []);
});

test("renames out of source and deletions cannot masquerade as release notes", () => {
  const paths = comparisonPaths({ files: [
    { filename: "releases/v2026.1029.0.md", previous_filename: "packages/shared/src/constants.ts", status: "renamed" },
    { filename: "server/src/deleted.ts", status: "removed" },
  ] });
  assert.ok(selectedTasks(plan(paths)).has("ci:server"));
  assert.ok(selectedTasks(plan(paths)).has("ci:db"));
});

test("unclassified paths and uncertain comparisons select full verification", () => {
  for (const paths of [[], ["new-root/file.ts"], ["../escaped"]]) {
    const result = plan(paths);
    assert.ok(result.forceReason);
    assert.ok(Object.values(result.jobs).every((job) => job.selected === job.total));
  }
  for (const files of [null, [], [{ status: "modified" }], [{ filename: "a", status: "renamed" }],
    Array.from({ length: 300 }, () => ({ filename: "ui/src/test.ts" }))]) {
    assert.throws(() => comparisonPaths({ files }));
  }
});

test("shadow mode explains savings but runs every task; force overrides selection", () => {
  const shadow = plan(["ui/src/components/Sidebar.tsx"], { mode: "shadow" });
  assert.equal(shadow.jobs.verify_serialized_server.proposed, 0);
  assert.equal(shadow.jobs.verify_serialized_server.selected, 9);
  for (const options of [{ mode: "full" }, { forceReason: "Stack" }]) {
    assert.ok(Object.values(plan(["ui/src/components/Sidebar.tsx"], options).jobs)
      .every((job) => job.selected === job.total));
  }
});

test("cache-affecting definition changes force execution across successive PR pushes", () => {
  for (const file of ["turbo.json", "package.json", "packages/db/package.json", "scripts/ci/run-task.mjs",
    ".github/actions/run-ci-task/action.yml"]) {
    for (const paths of [[file], [file, "packages/db/src/schema/issues.ts"]]) {
      const result = plan(paths);
      assert.match(result.forceReason, /Global CI input changed/);
      assert.ok(Object.values(result.jobs).every((job) => job.selected === job.total));
    }
  }
  const workflow = readFileSync(new URL(".github/workflows/pr-trusted.yml", root), "utf8");
  assert.equal((workflow.match(/force:.*\.forceReason != null/g) ?? []).length, 3);
  const action = readFileSync(new URL(".github/actions/run-ci-task/action.yml", root), "utf8");
  assert.match(action, /CI_FORCE_TASKS: \$\{\{ inputs.force \}\}/);
  assert.equal((action.match(/if:.*inputs.force != 'true'/g) ?? []).length, 2);
});

test("task dependencies propagate input changes and unsupported graph syntax fails closed", () => {
  const fixture = { globalDependencies: [], tasks: {
    "//#build": { inputs: ["lib/**"] }, "//#test": { inputs: ["app/**"], dependsOn: ["//#build"] },
  } };
  assert.equal(planTasks({ config: fixture, lanes: { tests: [{ task: "test" }] }, paths: ["lib/index.ts"] }).jobs.tests.run, true);
  fixture.tasks["//#build"].dependsOn = ["//#test"];
  assert.throws(() => planTasks({ config: fixture, lanes: { tests: [{ task: "test" }] }, paths: ["app/index.ts"] }), /Cyclic/);
  assert.throws(() => plan(["ui/src/a.ts"], { mode: "typo" }), /Invalid CI mode/);
});

test("local planner reads a real Git rename and handles a missing revision conservatively", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ci-plan-"));
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    git("init", "-q"); git("config", "user.name", "CI Test"); git("config", "user.email", "ci@example.invalid");
    mkdirSync(path.join(directory, "packages/shared/src"), { recursive: true });
    writeFileSync(path.join(directory, "packages/shared/src/input.ts"), "original\n");
    git("add", "."); git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD").trim();
    mkdirSync(path.join(directory, "releases"));
    git("mv", "packages/shared/src/input.ts", "releases/v1.md"); git("commit", "-qm", "rename");
    for (const revision of [base, "missing-revision"]) {
      const result = spawnSync(process.execPath, [new URL("../ci-plan.mjs", import.meta.url).pathname, revision], {
        cwd: directory, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: "", GITHUB_STEP_SUMMARY: "",
          CI_TASK_CONFIG: new URL("turbo.json", root).pathname, CI_TASK_MATRIX: new URL(".github/ci-task-matrix.json", root).pathname },
      });
      assert.equal(result.status, 0, result.stderr);
      const resultPlan = JSON.parse(result.stdout);
      assert.ok(selectedTasks(resultPlan).has("ci:server"));
      if (revision !== base) assert.match(resultPlan.forceReason, /Diff unavailable/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("required aggregates reject omitted, failed and cancelled selected work", () => {
  const workflow = readFileSync(new URL(".github/workflows/pr-trusted.yml", root), "utf8");
  for (const id of ["verify", "e2e"]) {
    const block = workflow.split(`\n  ${id}:\n`)[1].split(/\n  [a-z0-9_]+:\n/)[0];
    const code = block.split("          node --input-type=module <<'NODE'\n")[1].split("\n          NODE")[0]
      .split("\n").map((line) => line.slice(10)).join("\n");
    const names = /needs: \[([^\]]+)\]/.exec(block)[1].split(", ");
    const resultPlan = plan(["ui/src/components/Sidebar.tsx"]);
    const results = Object.fromEntries(names.map((name) => [name, { result:
      name === "gate" || name === "policy" || resultPlan.jobs[name]?.run ? "success" : "skipped" }]));
    const run = (env = {}) => spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8",
      env: { ...process.env, FULL_CI: "true", EVENT_NAME: "pull_request", CI_PLAN: JSON.stringify(resultPlan), CI_RESULTS: JSON.stringify(results), ...env } });
    assert.equal(run().status, 0);
    for (const name of names) {
      // Optional analysis can fail or be skipped; the unchanged task plan
      // still has to pass. Selected-plan cases are exercised separately.
      if (name === "test_selection") continue;
      const previous = results[name].result;
      for (const bad of previous === "success" ? ["failure", "cancelled", "skipped"] : ["success"]) {
        results[name].result = bad;
        assert.notEqual(run().status, 0, `${id}: ${name} must reject ${bad}`);
      }
      results[name].result = previous;
    }
    for (const result of ["failure", "cancelled", "skipped"]) {
      results.gate.result = result;
      const failedGate = run({ FULL_CI: "", CI_PLAN: "" });
      assert.notEqual(failedGate.status, 0, `${id}: an absent routing output must not pass`);
      assert.match(failedGate.stderr, /CI routing must succeed/);
    }
    assert.match(block, /^ {4}runs-on: \$\{\{ needs\.gate\.outputs\.runner \|\| 'ubuntu-latest' \}\}$/m,
      `${id}: the always-run summary must have a runner when routing produces no output`);
  }
});

test("the real routing step uses pinned trusted definitions and defaults to full on fetch failure", () => {
  const workflow = readFileSync(new URL(".github/workflows/ci-routing.yml", root), "utf8");
  const block = workflow.split("      - name: Plan affected CI tasks from trusted definitions\n")[1];
  const shell = block.split("        run: |\n")[1].split("\n").map((line) => line.slice(10)).join("\n");
  const directory = mkdtempSync(path.join(tmpdir(), "ci-routing-plan-"));
  try {
    const repository = path.join(directory, "source");
    mkdirSync(repository);
    const gitBin = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const git = (...args) => execFileSync(gitBin, args, { cwd: repository, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main"); git("config", "user.name", "CI"); git("config", "user.email", "ci@example.invalid");
    writeFileSync(path.join(repository, "base"), "base"); git("add", "."); git("commit", "-qm", "base");
    git("checkout", "-qb", "pr");
    mkdirSync(path.join(repository, "ui/src/components"), { recursive: true });
    writeFileSync(path.join(repository, "ui/src/components/Sidebar.tsx"), "change");
    git("add", "."); git("commit", "-qm", "PR");
    const prHead = git("rev-parse", "HEAD");
    git("checkout", "-q", "main");
    writeFileSync(path.join(repository, "unrelated-master"), "already merged");
    git("add", "."); git("commit", "-qm", "advance base");
    const base = git("rev-parse", "HEAD");
    git("merge", "--no-ff", "pr", "-m", "tested merge");
    const merge = git("rev-parse", "HEAD");
    writeFileSync(path.join(directory, "git"), `#!/usr/bin/env node
const {spawnSync}=require('node:child_process');
if(process.env.TEST_GIT_FAILURE==='true')process.exit(1);
const args=process.argv.slice(2).map(a=>a==='https://github.com/paperclipai/paperclip.git'?process.env.TEST_GIT_REPOSITORY:a);
const r=spawnSync(${JSON.stringify(gitBin)},args,{stdio:'inherit'});process.exit(r.status??1);
`);
    chmodSync(path.join(directory, "git"), 0o755);
    const gh = path.join(directory, "gh");
    writeFileSync(gh, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const endpoint = process.argv.find(arg => arg.startsWith('/repos/'));
if (endpoint?.endsWith('/git/ref/heads/master')) console.log('a'.repeat(40));
else if (endpoint?.includes('/contents/')) {
  if (process.env.TEST_FETCH_FAILURE === 'true') process.exit(1);
  const [file, query] = endpoint.split('/contents/')[1].split('?');
  if (query !== 'ref=' + 'a'.repeat(40)) process.exit(2);
  process.stdout.write(fs.readFileSync(path.join(process.env.TEST_TRUSTED_ROOT, file)));
}
else process.exit(3);
`);
    chmodSync(gh, 0o755);
    for (const overrides of [{}, { TEST_FETCH_FAILURE: "true" }, { TEST_GIT_FAILURE: "true" }, { PROFILE_CI: "true" }, { STACK_JSON: "{}" }, { FULL_CI: "false" }]) {
      const output = path.join(directory, "output");
      writeFileSync(output, "");
      const result = spawnSync("bash", ["-c", shell], { encoding: "utf8", env: {
        ...process.env, GITHUB_REPOSITORY: "paperclipai/paperclip", PATH: `${directory}:${process.env.PATH}`, TEST_TRUSTED_ROOT: root.pathname,
        RUNNER_TEMP: directory, FULL_CI: "true", PROFILE_CI: "false", FORCE_FULL_CI: "false",
        CI_INCREMENTAL_MODE: "enabled", STACK_JSON: "null", EVENT_BASE_SHA: "b".repeat(40), EVENT_HEAD_SHA: prHead, EVENT_MERGE_SHA: merge,
        TEST_GIT_REPOSITORY: repository,
        GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: "", ...overrides,
      } });
      assert.equal(result.status, 0, result.stderr);
      const value = readFileSync(output, "utf8").trim();
      if (overrides.TEST_FETCH_FAILURE || overrides.TEST_GIT_FAILURE || overrides.FULL_CI === "false") assert.equal(value, "plan=");
      else {
        assert.notEqual(value, "plan=", `${JSON.stringify(overrides)}: ${result.stderr}`);
        const resultPlan = JSON.parse(value.slice("plan=".length));
        assert.equal(resultPlan.jobs.general_tests.selected, overrides.PROFILE_CI || overrides.STACK_JSON ? 19 : 2);
        assert.equal(resultPlan.diff.base, base);
        assert.deepEqual(resultPlan.changed, ["ui/src/components/Sidebar.tsx"]);
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test("audited prose does not widen source selection, but guidance still runs its uncached guard", () => {
  const source = "ui/src/components/Sidebar.tsx";
  const sourcePlan = plan([source]);
  for (const doc of ["doc/DEVELOPING.md", "doc/DATABASE.md", "doc/plans/2026-10-30-example.md"]) {
    const mixed = plan([source, doc]);
    assert.equal(mixed.forceReason, null);
    assert.deepEqual(mixed.jobs, sourcePlan.jobs);
    assert.deepEqual(mixed.documentation, [doc]);
  }
  const guidance = plan(["doc/DEVELOPING.md"]);
  assert.deepEqual([...selectedTasks(guidance)], ["ci:typecheck"]);
  assert.equal(config.tasks["//#ci:typecheck"].cache, false);
  assert.deepEqual([...selectedTasks(plan(["doc/plans/2026-10-30-example.md"]))], []);
  for (const file of ["docs/api/issues.md", "doc/unknown.md", "doc/plans/tool.sh", "skills/paperclip/SKILL.md",
    "server/src/onboarding-assets/default/AGENTS.md", "tests/fixtures/example.md"]) {
    assert.ok(selectedTasks(plan([source, file])).has("ci:server"), file);
  }
});

test("complete merge trees handle more than 300 files, base advancement, renames and deletions", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "ci-merge-diff-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  const write = (file, value) => { mkdirSync(path.dirname(path.join(directory, file)), { recursive: true }); writeFileSync(path.join(directory, file), value); };
  const commit = () => { git("add", "."); git("commit", "-qm", "fixture"); return git("rev-parse", "HEAD"); };
  git("init", "-q", "-b", "main"); git("config", "user.name", "CI"); git("config", "user.email", "ci@example.invalid");
  write("ui/src/deleted.ts", "old"); write("ui/src/renamed.ts", "rename"); const staleBase = commit();
  git("checkout", "-qb", "pr");
  for (let index = 0; index < 350; index++) write(`ui/src/component-${index}.ts`, "new");
  git("rm", "ui/src/deleted.ts");
  mkdirSync(path.join(directory, "doc/plans"), { recursive: true });
  git("mv", "ui/src/renamed.ts", "doc/plans/2026-10-30-moved.md");
  const prHead = commit();
  git("checkout", "-q", "main"); write(".github/workflows/unrelated.yml", "already merged CI change"); const base = commit();
  git("merge", "--no-ff", "pr", "-m", "tested merge"); const head = git("rev-parse", "HEAD");
  const result = mergeDiff(head, prHead, directory);
  assert.equal(result.diff.base, base); assert.notEqual(result.diff.base, staleBase);
  assert.equal(result.changed.length, 353);
  assert.ok(result.changed.includes("ui/src/deleted.ts")); assert.ok(result.changed.includes("ui/src/renamed.ts"));
  assert.ok(!result.changed.includes(".github/workflows/unrelated.yml"));
  assert.equal(plan(result.changed).forceReason, null);
  const shallow = path.join(directory, "shallow");
  git("clone", "--quiet", "--depth", "2", `file://${directory}`, shallow);
  assert.equal(execFileSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: shallow, encoding: "utf8" }).trim(), "true");
  assert.deepEqual(mergeDiff(head, prHead, shallow), result);
  assert.throws(() => mergeDiff(head, base, directory), /expected PR head/);
  assert.throws(() => mergeDiff(prHead, prHead, directory), /merge commit/);
  assert.throws(() => mergeDiff("f".repeat(40), prHead, directory));
});

test("a fork routing step plans from its own tested merge, never upstream master", () => {
  const workflow = readFileSync(new URL(".github/workflows/ci-routing.yml", root), "utf8");
  const block = workflow.split("      - name: Plan affected CI tasks from trusted definitions\n")[1];
  const shell = block.split("        run: |\n")[1].split("\n").map((line) => line.slice(10)).join("\n");
  const directory = mkdtempSync(path.join(tmpdir(), "ci-routing-fork-"));
  const fork = "someone/paperclip-fork";
  try {
    const repository = path.join(directory, "source");
    mkdirSync(repository);
    const gitBin = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const git = (...args) => execFileSync(gitBin, args, { cwd: repository, encoding: "utf8" }).trim();
    const write = (file, value) => { mkdirSync(path.dirname(path.join(repository, file)), { recursive: true }); writeFileSync(path.join(repository, file), value); };
    git("init", "-q", "-b", "master"); git("config", "user.name", "CI"); git("config", "user.email", "ci@example.invalid");
    write("base", "base"); git("add", "."); git("commit", "-qm", "base");
    const merges = {};
    for (const [name, files] of Object.entries({
      ui: ["ui/src/components/Sidebar.tsx"], server: ["server/src/index.ts"], lockfile: ["pnpm-lock.yaml"],
      rust: ["packages/paperclip-runner/runner/crates/runner-core/src/lib.rs"], plans: ["doc/plans/2026-11-08-example.md"],
      shared: ["packages/shared/src/types/issue.ts"], db: ["packages/db/src/schema/issues.ts"],
      adapterUtils: ["packages/adapter-utils/src/index.ts"], cargoLock: ["packages/paperclip-runner/runner/Cargo.lock"],
      cargoManifest: ["packages/paperclip-runner/runner/crates/runner-core/Cargo.toml"],
      nestedPnpmLock: ["packages/plugins/sandbox-providers/daytona/pnpm-lock.yaml"],
      npmLock: ["packages/paperclip-runner/scripts/pi-distribution/package-lock.json"],
    })) {
      git("checkout", "-q", "-b", name, "master");
      for (const file of files) write(file, name);
      git("add", "."); git("commit", "-qm", name);
      const prHead = git("rev-parse", "HEAD");
      git("checkout", "-q", "--detach", "master");
      git("merge", "-q", "--no-ff", name, "-m", `tested merge ${name}`);
      merges[name] = { prHead, merge: git("rev-parse", "HEAD"), base: git("rev-parse", "HEAD^1") };
    }
    git("checkout", "-q", "master");
    writeFileSync(path.join(directory, "git"), `#!/usr/bin/env node
const {spawnSync}=require('node:child_process');
if(process.env.TEST_GIT_FAILURE==='true')process.exit(1);
if(process.argv.includes('https://github.com/paperclipai/paperclip.git'))process.exit(4);
const args=process.argv.slice(2).map(a=>a==='https://github.com/${fork}.git'?process.env.TEST_GIT_REPOSITORY:a);
const r=spawnSync(${JSON.stringify(gitBin)},args,{stdio:'inherit'});process.exit(r.status??1);
`);
    chmodSync(path.join(directory, "git"), 0o755);
    writeFileSync(path.join(directory, "gh"), `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const endpoint = process.argv.find(arg => arg.startsWith('/repos/'));
fs.appendFileSync(process.env.TEST_GH_LOG, endpoint + '\\n');
if (!endpoint?.startsWith('/repos/${fork}/contents/')) process.exit(3);
if (process.env.TEST_FETCH_FAILURE === 'true') process.exit(1);
if (process.env.TEST_SCOPE_MISSING === 'true' && endpoint.includes('staple-ci-scope')) process.exit(1);
const [file, query] = endpoint.split('/contents/')[1].split('?');
if (query !== 'ref=' + process.env.EVENT_MERGE_SHA) process.exit(2);
process.stdout.write(fs.readFileSync(path.join(process.env.TEST_TRUSTED_ROOT, file)));
`);
    chmodSync(path.join(directory, "gh"), 0o755);
    const run = (name, overrides = {}) => {
      const output = path.join(directory, "output"), log = path.join(directory, "gh.log");
      writeFileSync(output, ""); writeFileSync(log, "");
      const result = spawnSync("bash", ["-c", shell], { encoding: "utf8", env: {
        ...process.env, GITHUB_REPOSITORY: fork, PATH: `${directory}:${process.env.PATH}`, TEST_TRUSTED_ROOT: root.pathname,
        RUNNER_TEMP: directory, FULL_CI: "true", PROFILE_CI: "false", FORCE_FULL_CI: "false",
        CI_INCREMENTAL_MODE: "enabled", STACK_JSON: "null", EVENT_HEAD_SHA: merges[name].prHead, EVENT_MERGE_SHA: merges[name].merge,
        TEST_GIT_REPOSITORY: repository, TEST_GH_LOG: log, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: "", ...overrides,
      } });
      assert.equal(result.status, 0, result.stderr);
      const endpoints = readFileSync(log, "utf8").split("\n").filter(Boolean);
      assert.ok(endpoints.every((endpoint) => endpoint.startsWith(`/repos/${fork}/contents/`)), endpoints.join(", "));
      const value = readFileSync(output, "utf8").trim();
      return value === "plan=" ? null : JSON.parse(value.slice("plan=".length));
    };
    const jobsRun = (resultPlan) => Object.fromEntries(Object.entries(resultPlan.jobs).map(([job, lane]) => [job, lane.selected]));

    // The Staple scope (STA-223, .github/staple-ci-scope.json) turns the fork's plan into a routine
    // push: the test lanes the task plan picks for the changed paths (file selection then narrows
    // them to the focused tests) and the suites that test a changed package's own paths. The
    // repository-wide build and typecheck, e2e, the Runner support suite and the canary are left
    // to the nightly certification.
    const certification = ["typecheck_release_registry", "build", "e2e_shards", "verify_runner_e2e_support", "canary_dry_run"];
    const routine = (resultPlan, name) => {
      assert.equal(resultPlan.forceReason, null, name);
      assert.equal(resultPlan.staple.scope, "routine", name);
      for (const job of certification) assert.equal(resultPlan.jobs[job].run, false, `${name}: ${job}`);
    };
    const ui = run("ui");
    routine(ui, "ui");
    assert.equal(ui.diff.base, merges.ui.base);
    // The published plan carries the changed list as its digest and count; test selection
    // verifies its own diff of the same merge parents against them.
    assert.equal(ui.changed, undefined);
    assert.equal(ui.changedCount, 1);
    assert.equal(ui.changedSha256, changedDigest(["ui/src/components/Sidebar.tsx"]));
    assert.deepEqual(ui.staple.affected, { run: true, all: null, packages: ["ui"] });
    assert.deepEqual(jobsRun(ui), { typecheck_release_registry: 0, general_tests: 2, docker_context_integrity: 0,
      sandbox_provider_tests: 0, verify_paperclip_runner: 0, build: 0, verify_serialized_server: 0, canary_dry_run: 0,
      e2e_shards: 0, verify_runner_e2e_support: 0 });
    // Without the scope map the fork keeps the unscoped task plan.
    assert.deepEqual(jobsRun(run("ui", { TEST_SCOPE_MISSING: "true" })), { typecheck_release_registry: 1, general_tests: 2,
      docker_context_integrity: 1, sandbox_provider_tests: 0, verify_paperclip_runner: 0, build: 1, verify_serialized_server: 0,
      canary_dry_run: 1, e2e_shards: 8, verify_runner_e2e_support: 1 });

    // server/src/index.ts is agent lifecycle. A routine push still plans only the server test lanes.
    const server = run("server");
    routine(server, "server");
    assert.deepEqual(jobsRun(server), { typecheck_release_registry: 0, general_tests: 15, docker_context_integrity: 0,
      sandbox_provider_tests: 0, verify_paperclip_runner: 0, build: 0, verify_serialized_server: 9, canary_dry_run: 0,
      e2e_shards: 0, verify_runner_e2e_support: 0 });
    assert.deepEqual(server.staple.affected.packages, ["server"]);

    const rust = run("rust");
    // Runner Rust lives under packages/**, which every Node consumer also reads.
    routine(rust, "rust");
    assert.ok(rust.jobs.verify_paperclip_runner.run);
    assert.ok(rust.jobs.verify_paperclip_runner.matrix.include.some((entry) => entry.task === "ci:runner-rust"));

    const plans = run("plans");
    routine(plans, "plans");
    assert.deepEqual(Object.keys(plans.jobs).filter((job) => plans.jobs[job].run), []);
    assert.equal(plans.staple.affected.run, false);

    // An upstream-sync branch is one more routine push: its name selects nothing.
    const sync = run("ui", { EVENT_HEAD_REF: "staple/upstream-sync-2026-11-10" });
    routine(sync, "sync");
    assert.deepEqual(jobsRun(sync), jobsRun(ui));

    // A root lockfile is a global input upstream. Here it typechecks every package and plans no test lane.
    const lockfile = run("lockfile");
    routine(lockfile, "lockfile");
    assert.match(lockfile.staple.upstreamForceReason, /Global CI input changed: pnpm-lock.yaml/);
    assert.deepEqual(lockfile.staple.affected, { run: true, all: "pnpm-lock.yaml", packages: [] });
    assert.ok(Object.values(lockfile.jobs).every((lane) => !lane.run));

    // packages/shared and packages/adapter-utils feed every server lane through packages/**.
    for (const name of ["shared", "adapterUtils"]) {
      const resultPlan = run(name);
      routine(resultPlan, name);
      assert.ok(resultPlan.jobs.general_tests.run && resultPlan.jobs.verify_serialized_server.run, name);
    }

    // Database schema and nested lockfiles or manifests select every lane upstream. A routine push
    // records that reason and still leaves the certification suites to the nightly run.
    for (const [name, file] of [["db", "packages/db/src/schema/issues.ts"], ["cargoLock", "packages/paperclip-runner/runner/Cargo.lock"],
      ["cargoManifest", "packages/paperclip-runner/runner/crates/runner-core/Cargo.toml"],
      ["nestedPnpmLock", "packages/plugins/sandbox-providers/daytona/pnpm-lock.yaml"],
      ["npmLock", "packages/paperclip-runner/scripts/pi-distribution/package-lock.json"]]) {
      const resultPlan = run(name);
      routine(resultPlan, name);
      assert.equal(resultPlan.staple.upstreamForceReason, `Global CI input changed: ${file}`, name);
    }
    assert.ok(run("cargoLock").jobs.verify_paperclip_runner.run);
    assert.deepEqual(run("db").staple.affected.packages, ["packages/db"]);

    // A label or a stack runs the complete suite: every lane, even for a one-file UI diff.
    for (const overrides of [{ PROFILE_CI: "true" }, { FORCE_FULL_CI: "true" }, { STACK_JSON: "{}" }]) {
      const complete = run("ui", overrides);
      assert.equal(complete.staple.scope, "full", JSON.stringify(overrides));
      assert.ok(complete.forceReason, JSON.stringify(overrides));
      assert.ok(Object.values(complete.jobs).every((lane) => lane.selected === lane.total), JSON.stringify(overrides));
    }
    for (const overrides of [{ TEST_FETCH_FAILURE: "true" }, { TEST_GIT_FAILURE: "true" }, { FULL_CI: "false" },
      { GITHUB_REPOSITORY: "someone/fork;rm" }, { EVENT_MERGE_SHA: "not-a-sha" }]) {
      assert.equal(run("ui", overrides), null, JSON.stringify(overrides));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
