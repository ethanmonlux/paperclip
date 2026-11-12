#!/usr/bin/env node
// Affected-package validation for a routine push (Staple, STA-223).
//
// The routing plan names the workspace packages a pull request changes
// (.github/scripts/staple-ci-scope.mjs). This typechecks those packages and
// every package that depends on them, one at a time, in place of the
// repository-wide typecheck and build that the nightly certification runs.
// A change to a root manifest, lockfile or TypeScript configuration affects
// every package, so it typechecks all of them.
import { spawnSync } from "node:child_process";
import { appendFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function typecheckArguments(affected) {
  if (!affected?.run) return null;
  if (!affected.all && !affected.packages?.length) throw new Error("An affected-package plan names no package");
  const scope = affected.all ? ["-r"] : affected.packages.flatMap((directory) => {
    if (!/^[A-Za-z0-9@._/-]+$/.test(directory) || directory.split("/").includes("..")) throw new Error(`Invalid package directory: ${directory}`);
    return ["--filter", `...{${directory}}`];
  });
  return [...scope, "--workspace-concurrency=1", "--if-present", "run", "typecheck"];
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const plan = JSON.parse(process.env.CI_PLAN || "null");
  const affected = plan?.staple?.affected;
  const args = typecheckArguments(affected);
  if (!args) {
    console.log("No workspace package is affected.");
  } else {
    const label = affected.all ? `every package (${affected.all} changed)` : `${affected.packages.join(", ")} and their dependents`;
    console.log(`Typechecking ${label}: pnpm ${args.join(" ")}`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Affected packages\n\nTypecheck: ${label}\n`);
    const result = spawnSync("pnpm", args, { stdio: "inherit", shell: process.platform === "win32",
      env: { ...process.env, PAPERCLIP_TYPECHECK_LOW_MEMORY: "1" } });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
}
