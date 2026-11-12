// Staple CI scope (STA-223): turn the fork's task plan into the routine plan for one pull request.
//
// The routing step runs this after ci-plan.mjs, on pull_request only, with the map in
// .github/staple-ci-scope.json. A routine push runs policy, a typecheck of the packages the change
// affects, and the focused regression tests whose import graph reaches the change (file selection
// in scripts/ci/select-tests.mjs). Suites the map marks "certification" (the repository-wide build
// and typecheck, e2e, the Runner support suite, the canary) never run on a routine push.
// The nightly staple-certify.yml run builds one merged master commit and runs the complete suite,
// and the installer installs only a commit it certified, so a regression outside a push's routine
// checks is caught there and never installed. The full-ci and profile-ci labels, stacks and a
// missing diff run the complete suite on the pull request: every lane, not the path-scoped plan.
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";
import { planTasks } from "./ci-plan.mjs";

const matchesAny = (file, globs) => globs.some((glob) => matchesGlob(file, glob));
const RULES = ["plan", "certification"];
// The lanes that scripts/ci/select-tests.mjs narrows to the focused tests.
const TEST_LANES = ["general_tests", "verify_serialized_server"];
// The published plan is a job output that later jobs receive as the CI_PLAN environment variable.
// GitHub caps job outputs at 1 MiB and Linux caps one environment string at 128 KiB, so it carries
// decisions, not per-file lists that grow with the diff: a 2,103-file upstream sync made a 976 KB
// plan. The complete lists stay in the step summary and in the plan scopePlan returns.
export const MAX_LISTED = 20;

export function boundedList(list) {
  return list.length <= MAX_LISTED ? list : [...list.slice(0, MAX_LISTED), `... and ${list.length - MAX_LISTED} more`];
}

/** Digest of a changed-file list, so a later job can verify its own diff against the trusted one. */
export function changedDigest(files) {
  return createHash("sha256").update([...new Set(files)].sort().join("\0")).digest("hex");
}

/** The plan as published: `changed` becomes its digest and count; display lists are bounded. */
export function publishedPlan(plan) {
  if (!plan) return plan;
  const { changed, ...rest } = plan;
  const staple = plan.staple && Object.fromEntries(Object.entries(plan.staple).map(([key, value]) =>
    [key, ["unplanned", "policyOnly"].includes(key) && Array.isArray(value) ? boundedList(value) : value]));
  return { ...rest, changedCount: new Set(changed).size, changedSha256: changedDigest(changed),
    documentation: boundedList(plan.documentation ?? []),
    reasons: Object.fromEntries(Object.entries(plan.reasons ?? {}).map(([task, list]) => [task, boundedList(list)])),
    ...(staple ? { staple } : {}) };
}

export function validateScope(scope, lanes) {
  if (scope?.version !== 2) throw new Error("Unsupported Staple CI scope");
  const globs = (value) => Array.isArray(value) && value.every((glob) => typeof glob === "string" && glob);
  if (!globs(scope.policyOnlyPaths)) throw new Error("Invalid policyOnlyPaths");
  const routine = scope.routine ?? {};
  if (!Number.isInteger(routine.maxTestJobs) || routine.maxTestJobs < 1) throw new Error("Invalid routine.maxTestJobs");
  if (!globs(routine.typecheckAllPaths) || !routine.typecheckAllPaths.length) throw new Error("Invalid routine.typecheckAllPaths");
  if (!globs(routine.testConfigPaths) || !routine.testConfigPaths.length) throw new Error("Invalid routine.testConfigPaths");
  const sets = scope.pathSets ?? {};
  for (const [name, value] of Object.entries(sets)) {
    if (!globs(value) || !value.length) throw new Error(`Invalid path set: ${name}`);
  }
  const known = (names) => Array.isArray(names) && names.length > 0 && names.every((name) => Object.hasOwn(sets, name));
  const jobs = Object.keys(scope.jobs ?? {}).sort(), planned = Object.keys(lanes).sort();
  if (JSON.stringify(jobs) !== JSON.stringify(planned)) throw new Error(`Scope jobs ${jobs} must match the task matrix ${planned}`);
  for (const [job, rule] of Object.entries(scope.jobs)) {
    if (RULES.includes(rule) || known(rule)) continue;
    const groups = rule?.groups;
    const laneGroups = new Set(lanes[job].map((entry) => entry.group));
    if (groups && Object.keys(groups).length && Object.entries(groups).every(([group, names]) => laneGroups.has(group) && known(names))) continue;
    throw new Error(`Invalid scope rule for ${job}`);
  }
}

function lane(entries, selected) {
  return { run: selected.length > 0, matrix: { include: selected.length ? selected : entries },
    selected: selected.length, proposed: selected.length, total: entries.length };
}

// The workspace package a changed file belongs to, from the map's package classification.
function packageOf(file, packages) {
  const parts = file.split("/");
  for (let length = parts.length - 1; length > 0; length--) {
    const dir = parts.slice(0, length).join("/");
    if (packages.some((key) => key === dir || (key.endsWith("/*") && matchesGlob(dir, key)))) return dir;
  }
  return null;
}

/**
 * Returns the plan to publish. `plan` is ci-plan.mjs output for the tested merge; `config` and
 * `lanes` are the turbo.json and task matrix it used. A null plan (planner fallback) stays null:
 * the jobs then run their complete matrix.
 */
export function scopePlan({ plan, scope, config, lanes, forceReason = null }) {
  validateScope(scope, lanes);
  if (!plan) return plan;
  // A complete suite selects every lane and carries a force reason, so no later step narrows it.
  const full = (reason) => ({ ...plan, forceReason: reason,
    jobs: Object.fromEntries(Object.entries(lanes).map(([job, entries]) => [job, lane(entries, entries)])),
    staple: { version: 2, scope: "full", reason, vitestSelection: false, focused: false, affected: { run: false, all: null, packages: [] } } });
  if (plan.mode !== "enabled") return full(`CI mode ${plan.mode}`);
  if (forceReason) return full(forceReason);
  if (!Array.isArray(plan.changed) || !plan.changed.length) return full("Missing diff");

  const policyOnly = plan.changed.filter((file) => matchesAny(file, scope.policyOnlyPaths));
  const scoped = plan.changed.filter((file) => !policyOnly.includes(file));
  // Global and unclassified inputs select every lane upstream. A routine push plans only the
  // files a lane names as its own input; the rest are reported and left to the certification.
  const laneConfig = { ...config, globalDependencies: [] };
  const owned = scoped.filter((file) => planTasks({ config: laneConfig, lanes, paths: [file], mode: "enabled" }).forceReason === null);
  const unplanned = scoped.filter((file) => !owned.includes(file));
  const replanned = owned.length ? planTasks({ config: laneConfig, lanes, paths: owned, mode: "enabled" }) : null;

  // The root Vitest configuration is an input of every test project, and no lane names it. Offer
  // every plan-ruled test lane to file selection, which then finds the projects it invalidates.
  const testConfig = scoped.find((file) => matchesAny(file, scope.routine.testConfigPaths)) ?? null;
  const touched = (names) => names.some((name) => scoped.some((file) => matchesAny(file, scope.pathSets[name])));
  const jobs = {}, gates = {}, deferred = [];
  for (const [job, rule] of Object.entries(scope.jobs)) {
    const entries = lanes[job];
    let selected = replanned?.jobs[job].run ? replanned.jobs[job].matrix.include : [];
    if (testConfig && TEST_LANES.includes(job)) selected = entries;
    if (rule === "certification") {
      gates[job] = "nightly certification";
      deferred.push(job);
      selected = [];
    } else if (Array.isArray(rule)) {
      // A suite that tests its own paths runs with them: the lanes the plan names for the change,
      // or all of its lanes when the changed path is one only the upstream global inputs cover.
      if (!touched(rule)) {
        if (selected.length) gates[job] = `no change under ${rule.join(", ")}`;
        selected = [];
      } else if (!selected.length) selected = entries;
    } else if (rule.groups) {
      const before = selected.length;
      selected = selected.filter((entry) => !rule.groups[entry.group] || testConfig || touched(rule.groups[entry.group]));
      if (selected.length < before) {
        gates[job] = Object.entries(rule.groups).filter(([, names]) => !touched(names))
          .map(([group, names]) => `${group}: no change under ${names.join(", ")}`).join("; ");
      }
    }
    jobs[job] = lane(entries, selected);
  }
  const all = scoped.find((file) => matchesAny(file, scope.routine.typecheckAllPaths)) ?? null;
  const packages = [...new Set(scoped.map((file) => packageOf(file, Object.keys(scope.packages))).filter(Boolean))].sort();
  return {
    ...plan,
    forceReason: null,
    reasons: replanned?.reasons ?? Object.fromEntries(Object.keys(plan.reasons ?? {}).map((task) => [task, []])),
    jobs,
    staple: { version: 2, scope: "routine", vitestSelection: true, focused: true, maxTestJobs: scope.routine.maxTestJobs,
      policyOnly, gates, deferred, unplanned, ...(testConfig ? { testConfig } : {}), affected: { run: Boolean(all) || packages.length > 0, all, packages },
      ...(plan.forceReason ? { upstreamForceReason: plan.forceReason } : {}) },
  };
}

export function scopeSummary(plan) {
  if (!plan?.staple) return "";
  const { staple } = plan;
  const rows = Object.entries(plan.jobs).map(([job, value]) => `| ${job} | ${value.selected}/${value.total} | ${staple.gates?.[job] ?? ""} |`);
  const list = (files) => `${files.slice(0, 8).join(", ")}${files.length > 8 ? ` and ${files.length - 8} more` : ""}`;
  const affected = staple.affected?.all ? `every package (${staple.affected.all} changed)`
    : staple.affected?.packages.length ? list(staple.affected.packages) : "none";
  return ["### Staple CI scope", "",
    ...(staple.scope === "full" ? [`Complete suite: ${staple.reason}`] : [
      "Routine push: policy, a typecheck of the affected packages, and focused regression tests.",
      "Suites marked nightly certification run on the merged master commit before anything is installed. The `full-ci` label runs them on this pull request.",
      "", `Affected packages (typecheck): ${affected}`,
      ...(staple.unplanned.length ? ["", `Inputs no routine suite owns, left to the certification: ${list(staple.unplanned)}`] : []),
      ...(staple.policyOnly.length ? ["", `Policy-only inputs: ${list(staple.policyOnly)}`] : [])]),
    "", "| Suite | Lanes before file selection | Scope gate |", "| --- | ---: | --- |", ...rows, ""].join("\n");
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const raw = readFileSync(process.env.CI_PLAN_OUTPUT, "utf8").split("\n").find((line) => line.startsWith("plan="));
  if (raw === undefined) throw new Error("ci-plan.mjs published no plan");
  const value = raw.slice("plan=".length);
  const plan = scopePlan({
    plan: value ? JSON.parse(value) : null,
    scope: JSON.parse(readFileSync(process.env.CI_SCOPE ?? ".github/staple-ci-scope.json", "utf8")),
    config: JSON.parse(readFileSync(process.env.CI_TASK_CONFIG ?? "turbo.json", "utf8")),
    lanes: JSON.parse(readFileSync(process.env.CI_TASK_MATRIX ?? ".github/ci-task-matrix.json", "utf8")),
    forceReason: process.env.CI_FORCE_REASON || null,
  });
  const line = `plan=${plan ? JSON.stringify(publishedPlan(plan)) : ""}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
  else process.stdout.write(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, scopeSummary(plan));
}
