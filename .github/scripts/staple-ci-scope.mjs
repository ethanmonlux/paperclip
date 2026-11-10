// Staple PR CI scope (STA-223): narrow the fork's task plan to the suites that cover a PR's changes.
//
// The routing step runs this after ci-plan.mjs, on pull_request only, with the map in
// .github/staple-ci-scope.json. PRs keep build, typecheck and policy, the suites the upstream task
// plan selects for the changed paths, and the heavy suites (e2e, Runner, Docker, canary) only when
// a change touches the paths they cover. Upstream-sync branches, the full-ci/profile-ci labels,
// stacks and any path the plan cannot classify keep the complete plan. The nightly
// staple-certify.yml run always runs the complete suite, and the installer installs only commits it
// certified, so a regression outside a PR's scope is caught there and never installed.
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";
import { planTasks } from "./ci-plan.mjs";

const matchesAny = (file, globs) => globs.some((glob) => matchesGlob(file, glob));

export function validateScope(scope, lanes) {
  if (scope?.version !== 1) throw new Error("Unsupported Staple CI scope");
  for (const key of ["fullSuiteBranches", "policyOnlyPaths"]) {
    if (!Array.isArray(scope[key]) || scope[key].some((glob) => typeof glob !== "string" || !glob)) throw new Error(`Invalid ${key}`);
  }
  const sets = scope.pathSets ?? {};
  for (const [name, globs] of Object.entries(sets)) {
    if (!Array.isArray(globs) || !globs.length || globs.some((glob) => typeof glob !== "string" || !glob)) throw new Error(`Invalid path set: ${name}`);
  }
  const known = (names) => Array.isArray(names) && names.length > 0 && names.every((name) => Object.hasOwn(sets, name));
  const jobs = Object.keys(scope.jobs ?? {}).sort(), planned = Object.keys(lanes).sort();
  if (JSON.stringify(jobs) !== JSON.stringify(planned)) throw new Error(`Scope jobs ${jobs} must match the task matrix ${planned}`);
  for (const [job, rule] of Object.entries(scope.jobs)) {
    if (rule === "always" || rule === "plan" || known(rule)) continue;
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

/**
 * Returns the plan to publish. `plan` is ci-plan.mjs output for the tested merge; `config` and
 * `lanes` are the turbo.json and task matrix it used. A null plan (planner fallback) stays null:
 * the jobs then run their complete matrix.
 */
export function scopePlan({ plan, scope, config, lanes, headRef = "", forceReason = null }) {
  validateScope(scope, lanes);
  if (!plan) return plan;
  const full = (reason) => ({ ...plan, staple: { version: 1, scope: "full", reason, vitestSelection: false } });
  if (plan.mode !== "enabled") return full(`CI mode ${plan.mode}`);
  if (forceReason) return full(forceReason);
  if (headRef && scope.fullSuiteBranches.some((glob) => matchesGlob(headRef, glob))) return full(`Full-suite branch ${headRef}`);
  if (!Array.isArray(plan.changed) || !plan.changed.length) return full("Missing diff");

  const policyOnly = plan.changed.filter((file) => matchesAny(file, scope.policyOnlyPaths));
  const scoped = plan.changed.filter((file) => !policyOnly.includes(file));
  // Policy-only files are tested by the always-run policy job; plan the rest as their own diff.
  const replanned = scoped.length ? planTasks({ config, lanes, paths: scoped, mode: "enabled" }) : null;
  if (replanned?.forceReason) return full(replanned.forceReason);

  const touched = (names) => names.some((name) => scoped.some((file) => matchesAny(file, scope.pathSets[name])));
  const jobs = {}, gates = {};
  for (const [job, rule] of Object.entries(scope.jobs)) {
    const entries = lanes[job];
    if (rule === "always") { jobs[job] = lane(entries, entries); continue; }
    let selected = replanned?.jobs[job].run ? replanned.jobs[job].matrix.include : [];
    if (Array.isArray(rule) && selected.length && !touched(rule)) {
      gates[job] = `no change under ${rule.join(", ")}`;
      selected = [];
    } else if (rule.groups) {
      const before = selected.length;
      selected = selected.filter((entry) => !rule.groups[entry.group] || touched(rule.groups[entry.group]));
      if (selected.length < before) {
        gates[job] = Object.entries(rule.groups).filter(([, names]) => !touched(names))
          .map(([group, names]) => `${group}: no change under ${names.join(", ")}`).join("; ");
      }
    }
    jobs[job] = lane(entries, selected);
  }
  return {
    ...plan,
    forceReason: null,
    reasons: replanned?.reasons ?? Object.fromEntries(Object.keys(plan.reasons ?? {}).map((task) => [task, []])),
    jobs,
    staple: { version: 1, scope: "change-scoped", vitestSelection: true, policyOnly, gates,
      ...(plan.forceReason ? { upstreamForceReason: plan.forceReason } : {}) },
  };
}

export function scopeSummary(plan) {
  if (!plan?.staple) return "";
  const { staple } = plan;
  const rows = Object.entries(plan.jobs).map(([job, value]) => `| ${job} | ${value.selected}/${value.total} | ${staple.gates?.[job] ?? ""} |`);
  return ["### Staple PR scope", "",
    staple.scope === "full" ? `Complete suite: ${staple.reason}` : "Change-scoped. The nightly certification runs the complete suite.",
    ...(staple.policyOnly?.length ? ["", `Policy-only inputs: ${staple.policyOnly.join(", ")}`] : []),
    "", "| Suite | Scheduled jobs | Scope gate |", "| --- | ---: | --- |", ...rows, ""].join("\n");
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
    headRef: process.env.EVENT_HEAD_REF ?? "",
    forceReason: process.env.CI_FORCE_REASON || null,
  });
  const line = `plan=${plan ? JSON.stringify(plan) : ""}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
  else process.stdout.write(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, scopeSummary(plan));
}
