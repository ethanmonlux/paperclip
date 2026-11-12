import { execFileSync } from "node:child_process";
import { appendFileSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import { refineTestPlan, selectionDurations } from "./test-selection-plan.mjs";
import { productInputs } from "../../.github/scripts/ci-inputs.mjs";
import { mergeDiff } from "../../.github/scripts/ci-diff.mjs";
import { selectProjects } from "./select-projects.mjs";

export function selectionEligibility(plan, root = process.cwd()) {
  if (plan?.version !== 1 || plan.mode !== "enabled" || plan.forceReason) return "Full/shadow/forced task plan";
  if (!Array.isArray(plan.changed) || !plan.changed.length) return "Incomplete comparison";
  const changed = productInputs(plan.changed);
  if (!changed.length) return "Documentation-only diff";
  for (const file of changed) {
    // Business modules can contain "config"/"setup" in their names. The graph
    // separately tracks actual setup and configuration dependencies.
    if (!/^(?:ui\/src|server\/src|cli\/src|packages\/.+\/src)\/.+\.[cm]?[jt]sx?$/.test(file)
      || /(?:^|\/)(?:vite|vitest)\.(?:config|setup)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$/i.test(file)
      || file.split("/").includes("..")) return `Broad input: ${file}`;
    try {
      if (!lstatSync(path.join(root, file)).isFile()) return `Non-regular source: ${file}`;
    } catch { return `Deleted or missing source: ${file}`; }
  }
  return null;
}

function runnerInventory(group) {
  const args = group === "serialized" ? ["--mode", "serialized", "--shard-index", "0", "--shard-count", "1"]
    : ["--mode", "general", "--group", group,
      ...(group === "general-server-without-chat" ? ["--shard-index", "0", "--shard-count", "1"] : [])];
  const env = { ...process.env, GITHUB_WORKFLOW: "PR" };
  delete env.PAPERCLIP_CI_TEST_SELECTION;
  return JSON.parse(execFileSync(process.execPath, ["scripts/run-vitest-stable.mjs", ...args, "--dry-run"],
    { env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
}

const graphable = (file, root) => /^(?:ui\/src|server\/src|cli\/src|packages\/.+\/src)\/.+\.[cm]?[jt]sx?$/.test(file)
  && !/(?:^|\/)(?:vite|vitest)\.(?:config|setup)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$/i.test(file)
  && !file.split("/").includes("..") && lstatSync(path.join(root, file), { throwIfNoEntry: false })?.isFile() === true;

// Focused regression for a routine push (Staple, STA-223). The complete selection also keeps every
// test whose imports reach a filesystem, process, network or other opaque module, because the
// graph cannot prove such a test ignores the change: 1,722 of 1,903 server files for a six-file
// change. Those tests are not known to be affected. A routine push runs the tests that are: the
// changed tests, the tests whose import graph reaches a changed source, and the tests that declare
// a changed file as an input. A changed setup or configuration dependency still selects its whole
// project. The opaque remainder is counted, named in the audit and left to the certification.
export function focusGraph(graph, changed) {
  if (wholeProject(graph)) return { ...graph, deferred: [] };
  const direct = new Set([...graph.related, ...graph.inputRelated, ...graph.inventory.filter((file) => changed.includes(file))]);
  const deferred = graph.alwaysRun.filter((file) => graph.retentionReasons[file] && !direct.has(file));
  const skip = new Set(deferred);
  return { ...graph, selected: graph.selected.filter((file) => !skip.has(file)), deferred };
}

// A changed setup or configuration dependency, or a shared worker, affects every test of a project.
const wholeProject = (graph) => graph.setupChanged || !graph.isolated;

// The selections a routine push tries, nearest tests first, when the affected tests exceed its
// budget. A whole project is in every candidate unchanged.
export function budgetCandidates(graphs, changed, sources) {
  // heartbeat.ts has 209 direct importers; heartbeat-*.test.ts and its directory's tests are the nearest.
  const stems = sources.map((file) => path.posix.basename(file).replace(/(?:\.test)?\.[cm]?[jt]sx?$/, ""));
  const directories = new Set(sources.map((file) => path.posix.dirname(file)));
  const near = (file) => directories.has(path.posix.dirname(file)) || stems.some((stem) => path.posix.basename(file).startsWith(stem));
  const narrowed = (keep) => graphs.map((graph) => {
    if (wholeProject(graph)) return graph;
    const kept = keep(graph);
    return { ...graph, selected: graph.selected.filter((file) => kept.has(file)) };
  });
  return [
    ["the changed tests and the tests that import a changed source directly",
      (graph) => new Set([...graph.direct, ...graph.inputRelated, ...changed])],
    ["the changed tests and the direct importers named after or beside a changed source",
      (graph) => new Set([...graph.direct.filter(near), ...changed])],
    ["the changed tests", () => new Set(changed)],
    ["no test", () => new Set()],
  ].map(([label, keep]) => ({ label, graphs: narrowed(keep) }));
}

export async function createTestSelection(plan, head, root = process.cwd()) {
  const focused = plan?.staple?.focused === true;
  const reason = focused ? null : selectionEligibility(plan);
  if (reason) throw new Error(reason);
  const groups = new Set();
  for (const job of ["general_tests", "verify_serialized_server"]) {
    if (plan.jobs[job].run) for (const entry of plan.jobs[job].matrix.include) groups.add(entry.group ?? "serialized");
  }
  groups.delete("general-chat"); // Keep its line sharding and DB ownership intact.
  // Every changed input goes to the graphs, not only the sources: a changed setup file, Vitest
  // configuration or declared fixture is how a graph learns that a whole project or an
  // input-reading test is affected.
  const changed = productInputs(plan.changed);
  const sources = focused ? changed.filter((file) => graphable(file, root)) : changed;
  const focus = focused ? { changed: changed.length, ungraphed: changed.filter((file) => !sources.includes(file)),
    uncovered: [], unrouted: [], deferred: {}, wholeProjects: [], budget: { maxJobs: plan.staple.maxTestJobs, jobs: 0, exceeded: null } } : null;
  if (focused && (!changed.length || !groups.size)) {
    return { ...refineTestPlan({ plan, head, owners: {}, graphs: [], empty: true, focus }), graphs: [] };
  }
  const owners = {}, projects = new Set(), inventories = new Map();
  const inventoryFor = group => {
    if (!inventories.has(group)) inventories.set(group, runnerInventory(group));
    return inventories.get(group);
  };
  for (const group of groups) {
    const inventory = inventoryFor(group);
    if (group === "serialized" || group === "general-server-without-chat") {
      owners[group] = { "@paperclipai/server": group === "serialized"
        ? inventory.selectedSerializedSuites : inventory.selectedGeneralServerSuites };
      projects.add("@paperclipai/server");
    } else {
      owners[group] = Object.fromEntries(inventory.workspaceProjects.map((project) => [project, null]));
      for (const project of inventory.workspaceProjects) projects.add(project);
    }
  }
  // Vitest reruns every test for any changed package.json. A manifest is not a test input: the
  // affected-package typecheck owns it, and it is named below as left to the certification.
  const graphInputs = focused ? changed.filter((file) => path.posix.basename(file) !== "package.json") : changed;
  let graphs = await selectProjects({ projects: [...projects], changed: graphInputs });
  // The root Vitest configuration is every project's configuration, so it invalidates them all.
  if (focused && plan.staple.testConfig) graphs = graphs.map((graph) => ({ ...graph, setupChanged: true, selected: graph.inventory }));
  if (focused) graphs = graphs.map((graph) => focusGraph(graph, changed));
  for (const graph of graphs) {
    const { project } = graph;
    console.log(`${project}: ${graph.selected.length}/${graph.inventory.length} files, ${focused
      ? `${graph.deferred.length} opaque files left to the certification` : `${graph.alwaysRun.length} retained conservatively`}, ${graph.seconds.toFixed(1)}s`);
    for (const owner of Object.values(owners)) if (owner[project] === null) owner[project] = graph.inventory;
    if (focused && graph.deferred.length) focus.deferred[project] = graph.deferred.length;
  }
  const covered = new Set(graphs.flatMap((graph) => graph.coveredChanges));
  for (const file of changed) {
    if (covered.has(file)) continue;
    assert.ok(focused, `Change outside the resolved test graphs: ${file}`);
  }
  if (focused) {
    if (plan.staple.testConfig) covered.add(plan.staple.testConfig);
    focus.ungraphed = changed.filter((file) => !covered.has(file) && !sources.includes(file));
    focus.uncovered = sources.filter((file) => !covered.has(file));
    focus.wholeProjects = graphs.filter(wholeProject).map((graph) => graph.project);
  }
  const server = graphs.find((graph) => graph.project === "@paperclipai/server");
  if (server) {
    const general = inventoryFor("general-server-without-chat");
    const native = inventoryFor("general-server-native-runner");
    assert.deepEqual([...general.selectedGeneralServerSuites, ...general.selectedSerializedSuites,
      ...native.selectedGeneralServerSuites, "server/src/__tests__/chat-channels.integration.test.ts"].sort(),
    server.inventory, "Server inventory must be completely covered by existing lane ownership");
  }
  if (!focused) return { ...refineTestPlan({ plan, head, owners, graphs, durations: selectionDurations() }), graphs };
  // Affected tests that no selected lane owns (the chat and native Runner lanes keep their own
  // ownership) are named, not dropped silently.
  const routed = new Set(Object.values(owners).flatMap((owner) => Object.values(owner).flat()));
  focus.unrouted = graphs.flatMap((graph) => graph.selected.filter((file) => !routed.has(file))).sort();
  const refine = (candidates) => refineTestPlan({ plan, head, owners, graphs: candidates, durations: selectionDurations(), focus });
  const jobs = (result) => result.plan.testSelection.stats.reduce((total, lane) => total + lane.jobs, 0);
  let result = refine(graphs);
  focus.budget.jobs = jobs(result);
  if (focus.budget.jobs > focus.budget.maxJobs) {
    // More affected tests than a routine push runs (a widely re-exported source reaches most of
    // the suite). Keep the nearest tests that fit: the changed tests with the tests that import a
    // changed source directly, then only those named after or beside it, then the changed tests
    // alone. The rest is left to the certification. Never present a near-complete run as light.
    // A project that a setup or configuration change invalidates is never pruned: it runs whole,
    // over the budget if it must.
    const files = graphs.reduce((total, graph) => total + graph.selected.length, 0);
    const complete = graphs;
    let kept;
    for (const candidate of budgetCandidates(graphs, changed, sources)) {
      graphs = candidate.graphs;
      result = refine(graphs);
      kept = candidate.label;
      if (jobs(result) <= focus.budget.maxJobs) break;
    }
    // The audit names every affected test the budget left to the certification.
    graphs = graphs.map((graph, index) => {
      const selected = new Set(graph.selected);
      return { ...graph, budgetDeferred: complete[index].selected.filter((file) => !selected.has(file)) };
    });
    if (focus.wholeProjects.length === graphs.length) kept = "every test of every project";
    else if (focus.wholeProjects.length) kept = `every test of ${focus.wholeProjects.join(", ")}, and ${kept} of the other projects`;
    focus.budget.exceeded = { files, jobs: focus.budget.jobs, kept,
      left: graphs.reduce((total, graph) => total + graph.budgetDeferred.length, 0) };
    focus.budget.jobs = jobs(result);
  }
  return { ...result, graphs };
}

function focusSummary(focus) {
  const list = (files) => `${files.slice(0, 8).join(", ")}${files.length > 8 ? ` and ${files.length - 8} more` : ""}`;
  const deferred = Object.values(focus.deferred).reduce((total, count) => total + count, 0);
  return ["Focused regression for a routine push: the changed tests, the tests whose import graph reaches a changed source, and the tests that declare a changed file as an input.", "",
    `- Changed inputs given to the test graphs: ${focus.changed}`,
    ...(deferred ? [`- Tests kept only because their imports reach an opaque module (filesystem, process, network): ${deferred}. Not known to be affected; they run in the nightly certification.`] : []),
    ...(focus.wholeProjects.length ? [`- A setup or configuration change selects every test of: ${list(focus.wholeProjects)}. These projects are never pruned.`] : []),
    ...(focus.budget.exceeded ? [`- ${focus.budget.exceeded.files} affected test files need ${focus.budget.exceeded.jobs} jobs, over the routine budget of ${focus.budget.maxJobs}. This run keeps ${focus.budget.exceeded.kept} (${focus.budget.jobs} jobs). The ${focus.budget.exceeded.left} affected files it leaves out are listed as \`budgetDeferred\` in audit.json. The complete suite runs in the nightly certification, or on this pull request with the \`full-ci\` label.`] : []),
    ...(focus.ungraphed.length ? [`- Changes outside the test import graphs (left to policy, typecheck and the certification): ${list(focus.ungraphed)}`] : []),
    ...(focus.uncovered.length ? [`- Changed sources no selected test imports: ${list(focus.uncovered)}`] : []),
    ...(focus.unrouted.length ? [`- Affected tests owned by the chat or native Runner lanes, which run when their own paths change and in the certification: ${list(focus.unrouted)}`] : []),
    ""].join("\n");
}

async function main() {
  const plan = JSON.parse(process.env.CI_PLAN || "null");
  const output = (key, value) => {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  };
  if (process.argv.includes("--eligible")) {
    const reason = plan?.staple?.focused === true ? null : selectionEligibility(plan);
    console.log(reason ?? "Source diff is eligible for graph selection");
    output("enabled", !reason);
    return;
  }
  const directory = ".ci-test-selection";
  mkdirSync(directory, { recursive: true });
  const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim();
  let result;
  try {
    const head = git("rev-parse", "HEAD");
    assert.equal(head, process.env.GITHUB_SHA, "Selection must describe the tested merge commit");
    assert.ok(plan.diff, "Missing trusted merge diff");
    const local = mergeDiff(head, plan.diff.prHead);
    assert.deepEqual(local.diff, plan.diff, "Selection must use the trusted merge parents");
    assert.deepEqual(local.changed, [...new Set(plan.changed)].sort(), "Local diff disagrees with the trusted routing diff");
    assert.equal(git("status", "--porcelain", "--untracked-files=normal"), "", "Source inputs changed during dependency setup");
    process.env.NODE_ENV = "test";
    process.env.VITEST = "true";
    result = await createTestSelection(plan, head);
    writeFileSync(`${directory}/manifest.json`, JSON.stringify(result.manifest));
    writeFileSync(`${directory}/audit.json`, JSON.stringify(result.graphs, null, 2));
    output("selected", "true");
  } catch (error) {
    console.warn(`Using the complete task plan: ${error.message}`);
    result = { plan: { ...plan, testSelectionFallback: error.message } };
    output("selected", "false");
  }
  writeFileSync(`${directory}/plan.json`, JSON.stringify(result.plan));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const stats = result.plan.testSelection?.stats;
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, stats
      ? ["### Vitest test selection", "", "| Lane | Test files | Jobs |", "| --- | ---: | ---: |",
        ...stats.map((s) => `| ${s.group} | ${s.selected}/${s.total} | ${s.jobs}/${s.beforeJobs} |`), "",
        result.plan.testSelection.focus ? focusSummary(result.plan.testSelection.focus)
          : "Filesystem/process/opaque consumers are retained. Chat and native Runner lanes keep their existing ownership.", ""].join("\n")
      : `### Vitest test selection\n\nFull task plan: ${result.plan.testSelectionFallback}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
