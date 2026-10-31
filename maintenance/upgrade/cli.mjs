#!/usr/bin/env node
// Guarded upstream upgrade tooling. Dependency-free on purpose: it must run
// before a candidate's dependencies exist. Nothing here installs, restarts or
// activates a live service.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { evaluateAdmission } from "./lib/admission.mjs";
import { inventoryMigrations } from "./lib/migration-inventory.mjs";
import { loadRegistry, validateRegistry } from "./lib/registry.mjs";
import { evaluateUpstreamOnly, receiptDigest } from "./lib/upstream-only.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const defaultRegistry = path.join(repoRoot, "maintenance", "patch-registry.json");

const usage = `Usage:
  node maintenance/upgrade/cli.mjs validate [--registry FILE]
  node maintenance/upgrade/cli.mjs upstream-only --out DIR [--patch ID]... [--upstream SHA] [--fork SHA] [--install CMD]
      [--ports-sha SHA] [--isolation private-network|none] [--registry FILE]
  node maintenance/upgrade/cli.mjs admission --evidence FILE [--registry FILE]
  node maintenance/upgrade/cli.mjs migration-inventory --base SHA --candidate SHA [--dir packages/db/src/migrations]`;

function gitText(args) {
  const result = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

function migrationsAt(sha, dir) {
  return gitText(["ls-tree", "--name-only", `${sha}:${dir}`]).split("\n").filter((name) => name.endsWith(".sql")).sort()
    .map((name) => ({ name, sql: gitText(["show", `${sha}:${dir}/${name}`]) }));
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function main(argv) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      registry: { type: "string", default: defaultRegistry },
      out: { type: "string" },
      patch: { type: "string", multiple: true },
      upstream: { type: "string" },
      fork: { type: "string" },
      install: { type: "string" },
      "ports-sha": { type: "string" },
      isolation: { type: "string", default: "private-network" },
      evidence: { type: "string" },
      base: { type: "string" },
      candidate: { type: "string" },
      dir: { type: "string", default: "packages/db/src/migrations" },
    },
  });
  if (command === "migration-inventory") {
    if (!values.base || !values.candidate) throw new Error("--base and --candidate are required");
    const base = gitText(["rev-parse", `${values.base}^{commit}`]).trim();
    const candidate = gitText(["rev-parse", `${values.candidate}^{commit}`]).trim();
    const baseMigrations = migrationsAt(base, values.dir);
    const known = new Set(baseMigrations.map(({ name }) => name));
    const candidateMigrations = migrationsAt(candidate, values.dir).filter(({ name }) => !known.has(name));
    console.log(JSON.stringify({ base, candidate, dir: values.dir, ...inventoryMigrations({ baseMigrations, candidateMigrations }) }, null, 2));
    return 0;
  }
  const registry = loadRegistry(values.registry);
  if (command === "validate") {
    const errors = validateRegistry(registry);
    console.log(JSON.stringify({ valid: errors.length === 0, errors }, null, 2));
    return errors.length === 0 ? 0 : 1;
  }
  if (command === "upstream-only") {
    if (!values.out) throw new Error("--out is required");
    const errors = validateRegistry(registry);
    if (errors.length > 0) throw new Error(`Invalid registry: ${errors.join("; ")}`);
    const selected = values.patch?.length ? registry.patches.filter((patch) => values.patch.includes(patch.id)) : registry.patches;
    if (values.patch?.length && selected.length !== values.patch.length) throw new Error("Unknown --patch id");
    // Ported regressions run from a committed blob: default to this checkout's HEAD.
    const head = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
    const portSourceSha = values["ports-sha"] ?? (head.status === 0 ? head.stdout.trim() : null);
    const outDir = path.resolve(values.out);
    mkdirSync(outDir, { recursive: true });
    const receipts = selected.map((patch) => {
      const receipt = evaluateUpstreamOnly({
        repo: repoRoot,
        patch,
        upstreamSha: values.upstream ?? registry.firstCandidateUpstreamSha,
        forkSha: values.fork ?? registry.evidenceSourceSha ?? registry.forkPatchSourceSha,
        workDir: path.join(outDir, "work"),
        installArgv: values.install ? values.install.split(" ").filter(Boolean) : null,
        testIsolation: values.isolation,
        portSourceSha,
      });
      // One file per attempt; an earlier receipt is never overwritten.
      writeFileSync(path.join(outDir, `${patch.id}-${receipt.attemptId}.receipt.json`), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
      const reasons = receipt.reasons.length ? ` (${receipt.reasons.join(", ")})` : "";
      console.log(`${patch.id}: ${receipt.outcome}${reasons} receipt=${receiptDigest(receipt)} report=${receipt.report?.sha256 ?? "none"}`);
      return receipt;
    });
    return receipts.every((receipt) => receipt.outcome !== "unknown") ? 0 : 2;
  }
  if (command === "admission") {
    if (!values.evidence) throw new Error("--evidence is required");
    const decision = evaluateAdmission({ registry, ...readJson(values.evidence) });
    console.log(JSON.stringify(decision, null, 2));
    return decision.admit ? 0 : 3;
  }
  console.error(usage);
  return 64;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
