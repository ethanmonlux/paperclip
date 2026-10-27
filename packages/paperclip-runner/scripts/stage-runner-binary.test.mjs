import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { stageBuiltRunnerBinary, stageRunnerBinary } from "./stage-runner-binary.mjs";
import { RELEASE_RUNNER_TARGETS, releaseRunnerTargets, releaseDaemonManifest, verifyReleaseRunnerMetadata } from "./stage-release-runner-binaries.mjs";
import { paperclipRunnerBinaryNeedsBuild, resolveNativeRunnerDevBinary } from "../../../scripts/dev-runner-native-binary.mjs";
import { resolvePackagedRunnerBinary } from "../src/live/runner-binary.ts";

const contract = { package: { name: "@paperclipai/paperclip-runner", version: "0.0.0" },
  contracts: { runnerdArtifact: 2, nativeExecution: 1, harnessDriver: 1 }, prp: { name: "paperclip.runner", minimumVersion: 1, maximumVersion: 3 } };
const metadata = { binaryContractVersion: 2, nativeExecutionVersion: 1, harnessDriverVersion: 1,
  packageName: "@paperclipai/paperclip-runner", packageVersion: "0.0.0", prp: { name: "paperclip.runner", minimumVersion: 1, maximumVersion: 2 } };

test("release assembly uses the inert four-target contract and rejects unexpected selection data", async () => {
  const contract = JSON.parse(await readFile(new URL("../release-runner-targets.json", import.meta.url), "utf8"));
  assert.deepEqual(RELEASE_RUNNER_TARGETS, ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"]);
  assert.deepEqual(releaseRunnerTargets(contract), RELEASE_RUNNER_TARGETS);
  assert.ok(Object.isFrozen(RELEASE_RUNNER_TARGETS));
  for (const invalid of [null, {}, { ...contract, schema: "other" }, { ...contract, host: "trusted-fleet" },
    { ...contract, targets: contract.targets.slice(0, 3) }, { ...contract, targets: [...contract.targets, "linux-arm64"] },
    { ...contract, targets: [...contract.targets.slice(0, 3), "win32-x64"] }, { ...contract, targets: "linux-arm64" }]) {
    assert.throws(() => releaseRunnerTargets(invalid), /Unknown release daemon target contract/);
  }
});

test("release assembly binds all four actual targets, source, hashes and compatible metadata", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "runner-release-inputs-"))), source = "a".repeat(40);
  const verify = value => verifyReleaseRunnerMetadata(value, contract);
  const receiptPath = target => path.join(root, target, "receipt.json");
  try {
    for (const target of RELEASE_RUNNER_TARGETS) {
      await mkdir(path.join(root, target));
      const bytes = Buffer.alloc(64);
      if (target.startsWith("linux-")) {
        bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); bytes.writeUInt16LE(target === "linux-x64" ? 62 : 183, 18);
      } else { bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(target === "darwin-x64" ? 0x01000007 : 0x0100000c, 4); }
      await writeFile(path.join(root, target, "paperclip-runnerd"), bytes);
      await writeFile(receiptPath(target), JSON.stringify({ schema: "paperclip.runner.release-artifact.v1", sourceRevision: source,
        target, sha256: "sha256:" + createHash("sha256").update(bytes).digest("hex"), buildMetadata: metadata }));
    }
    const actual = releaseDaemonManifest(root, source, verify);
    assert.deepEqual(Object.keys(actual.platforms), RELEASE_RUNNER_TARGETS);
    assert.equal(actual.remoteProviderPack, undefined, "Daemon-only data does not qualify a provider pack");
    assert.throws(() => releaseDaemonManifest(root, "b".repeat(40), verify), /source, digest or architecture/);
    const original = await readFile(receiptPath("darwin-arm64"), "utf8"), receipt = JSON.parse(original);
    for (const delta of [{ target: "darwin-x64" }, { sha256: "sha256:" + "0".repeat(64) }, { sourceRevision: "b".repeat(40) },
      { buildMetadata: { ...metadata, binaryContractVersion: 99 } }]) {
      await writeFile(receiptPath("darwin-arm64"), JSON.stringify({ ...receipt, ...delta }));
      assert.throws(() => releaseDaemonManifest(root, source, verify));
    }
    await writeFile(receiptPath("darwin-arm64"), original);
    const binary = path.join(root, "darwin-arm64/paperclip-runnerd"), bytes = await readFile(binary);
    await writeFile(binary, await readFile(path.join(root, "darwin-x64/paperclip-runnerd")));
    assert.throws(() => releaseDaemonManifest(root, source, verify), /digest or architecture/);
    await rm(binary); await symlink(path.join(root, "darwin-x64/paperclip-runnerd"), binary);
    assert.throws(() => releaseDaemonManifest(root, source, verify), /regular file/);
    await rm(binary); await writeFile(binary, bytes);
    const armBinary = path.join(root, "linux-arm64/paperclip-runnerd"), armBytes = await readFile(armBinary);
    const armReceipt = JSON.parse(await readFile(receiptPath("linux-arm64"), "utf8"));
    const wrongArm = await readFile(path.join(root, "linux-x64/paperclip-runnerd"));
    await writeFile(armBinary, wrongArm);
    await writeFile(receiptPath("linux-arm64"), JSON.stringify({ ...armReceipt, sha256: "sha256:" + createHash("sha256").update(wrongArm).digest("hex") }));
    assert.throws(() => releaseDaemonManifest(root, source, verify), /architecture mismatch/);
    await writeFile(armBinary, armBytes); await writeFile(receiptPath("linux-arm64"), JSON.stringify(armReceipt));
    await mkdir(path.join(root, "win32-x64"));
    assert.throws(() => releaseDaemonManifest(root, source, verify), /exactly the four/);
    await rm(path.join(root, "win32-x64"), { recursive: true });
    await rm(receiptPath("linux-arm64"));
    assert.throws(() => releaseDaemonManifest(root, source, verify), /only its daemon and receipt/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("release metadata rejects incompatible native, harness and protocol contracts without semver heuristics", () => {
  assert.equal(verifyReleaseRunnerMetadata(metadata, contract), metadata);
  for (const delta of [{ nativeExecutionVersion: 9 }, { harnessDriverVersion: 9 }, { packageName: "untrusted" },
    { prp: { ...metadata.prp, name: "other" } }, { prp: { ...metadata.prp, minimumVersion: 4, maximumVersion: 5 } }]) {
    assert.throws(() => verifyReleaseRunnerMetadata({ ...metadata, ...delta }, contract), /incompatible/);
  }
});

// Fixture executables here have to satisfy three separate requirements: dist
// resolution rejects any staged daemon whose ELF/Mach-O header does not match
// the host target, the staging tests execute the staged file under the
// `paperclip-runnerd` name, and the rebuild test needs two byte-distinct ones
// to tell fresh build output from the previous artifact.
//
// Borrowing /bin/sleep and /bin/echo meets none of that on an image whose
// coreutils is a single multi-call binary: both paths are then the same bytes,
// so "fresh build" and "previous build" are indistinguishable, and the staged
// copy dispatches on its own filename, so it reports an unknown program and
// exits instead of sleeping. That is a property of the host image, not of
// staging, and it made these tests fail wherever CI runs such an image.
//
// The shell is not part of coreutils, so it stays a standalone host-target
// executable that takes its behaviour from `-c` rather than from argv[0].
// Appending a trailing marker produces a second, byte-distinct copy that the
// ELF loader still executes, because trailing bytes sit outside every program
// header. macOS keeps the standalone BSD utilities: it has no multi-call
// coreutils, and stageRunnerBinary re-signs the staged Mach-O, which editing
// bytes after signing would break.
const FRESH_BUILD_MARKER = "\n# paperclip-runnerd test fixture: fresh source build\n";
const hostFixture = process.platform === "darwin"
  ? {
      previousBuild: { source: "/bin/sleep", marker: null, longRunningArgs: ["30"], exitZeroArgs: ["0"] },
      freshBuild: { source: "/bin/echo", marker: null, exitZeroArgs: ["rebuilt"] },
    }
  : {
      previousBuild: {
        source: "/bin/sh", marker: null,
        // exec replaces the shell, so the staged pathname owns the live process.
        longRunningArgs: ["-c", "exec sleep 30"], exitZeroArgs: ["-c", "exit 0"],
      },
      freshBuild: { source: "/bin/sh", marker: FRESH_BUILD_MARKER, exitZeroArgs: ["-c", "exit 0"] },
    };

async function withOwnedChildren(root, action) {
  const owned = [];
  const start = (command, args) => {
    const child = spawn(command, args, { env: { PATH: "/usr/bin:/bin" }, stdio: "ignore" });
    // close follows both exit and spawn error. A failed second spawn must not
    // interrupt retirement of the first still-running executable.
    const closed = new Promise(resolve => child.once("close", resolve));
    const spawned = once(child, "spawn");
    void spawned.catch(() => {});
    owned.push({ child, closed });
    return { child, spawned, closed };
  };
  try { return await action(start); }
  finally {
    try {
      const results = await Promise.allSettled(owned.map(async ({ child, closed }) => {
        if (child.pid && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await closed;
      }));
      const failures = results.filter(result => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Owned test child cleanup failed");
    } finally { await rm(root, { recursive: true, force: true }); }
  }
}

test("atomically publishes while the previous executable is running", { skip: process.platform === "win32", timeout: 15_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "runnerd-stage-test-"));
  const destination = path.join(root, "paperclip-runnerd");
  await withOwnedChildren(root, async start => {
    const { source, longRunningArgs, exitZeroArgs } = hostFixture.previousBuild;
    await stageRunnerBinary(source, destination);
    const previous = await stat(destination);
    const old = start(destination, longRunningArgs);
    await old.spawned;
    await stageRunnerBinary(source, destination);
    const published = await stat(destination);
    assert.notEqual(published.ino, previous.ino);
    assert.equal(published.mode & 0o777, 0o755);
    assert.equal(old.child.exitCode, null);
    assert.equal(old.child.signalCode, null);
    assert.deepEqual(await readdir(root), ["paperclip-runnerd"]);
    const next = start(destination, exitZeroArgs);
    await next.spawned; await next.closed;
    assert.equal(next.child.exitCode, 0);
  });
});

test("a source rebuild selects fresh dev bytes while preserving release binaries and their manifest", { skip: process.platform === "win32", timeout: 15_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "runnerd-stage-rebuild-"));
  const packageRoot = path.join(root, "packages", "paperclip-runner");
  const binaryRoot = path.join(packageRoot, "dist", "bin");
  const hostTarget = path.join(binaryRoot, `${process.platform}-${process.arch}`, "paperclip-runnerd");
  const source = path.join(packageRoot, "runner", "crates", "runner-core", "src", "main.rs");
  const built = path.join(packageRoot, "runner", "target", "release", "paperclip-runnerd");
  await withOwnedChildren(root, async start => {
    const copyHostFixture = async ({ source: fixture, marker }, output) => {
      await copyFile(fixture, output);
      if (process.platform === "darwin") {
        const slices = execFileSync("/usr/bin/lipo", ["-archs", fixture], { encoding: "utf8" }).trim().split(/\s+/);
        const architecture = slices.find(value => process.arch === "arm64" ? value.startsWith("arm64") : value === "x86_64");
        assert.ok(architecture);
        if (slices.length > 1) execFileSync("/usr/bin/lipo", [fixture, "-thin", architecture, "-output", output]);
      }
      // Trailing bytes keep the host-target header and stay outside every
      // program header, so the copy still loads and still runs.
      if (marker) await appendFile(output, marker);
    };
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "fn main() {}\n");
    await mkdir(path.dirname(built), { recursive: true });
    await copyHostFixture(hostFixture.freshBuild, built);
    const previousBuild = path.join(root, "previous-build");
    await copyHostFixture(hostFixture.previousBuild, previousBuild);
    await stageRunnerBinary(previousBuild, hostTarget);
    await stageRunnerBinary(built, path.join(binaryRoot, "paperclip-runnerd"));
    const platforms = {}, releaseBytes = new Map();
    for (const target of RELEASE_RUNNER_TARGETS) {
      const artifact = path.join(binaryRoot, target, "paperclip-runnerd");
      if (artifact !== hostTarget) {
        const header = Buffer.alloc(64);
        if (target.startsWith("linux-")) {
          header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); header.writeUInt16LE(target === "linux-x64" ? 62 : 183, 18);
        } else { header.writeUInt32LE(0xfeedfacf); header.writeUInt32LE(target === "darwin-x64" ? 0x01000007 : 0x0100000c, 4); }
        await mkdir(path.dirname(artifact), { recursive: true });
        await writeFile(artifact, header);
      }
      const bytes = await readFile(artifact);
      releaseBytes.set(artifact, bytes);
      platforms[target] = { path: `${target}/paperclip-runnerd`, sha256: "sha256:" + createHash("sha256").update(bytes).digest("hex") };
    }
    const oldTime = new Date(Date.now() - 10_000);
    await utimes(hostTarget, oldTime, oldTime);
    await utimes(path.join(binaryRoot, "paperclip-runnerd"), oldTime, oldTime);
    const oldArtifact = await readFile(hostTarget);
    const oldIdentity = await stat(hostTarget);
    const manifestPath = path.join(binaryRoot, "release-manifest.json");
    const manifest = JSON.stringify({ schema: "paperclip.runner.release-binaries.v1", sourceRevision: "a".repeat(40), platforms });
    await writeFile(manifestPath, manifest);
    const old = start(hostTarget, hostFixture.previousBuild.longRunningArgs);
    await old.spawned;
    const requirement = { repoRoot: root, nativeRunnerRequired: true };
    assert.equal(paperclipRunnerBinaryNeedsBuild(requirement), true);

    await stageBuiltRunnerBinary(packageRoot);

    const selected = resolveNativeRunnerDevBinary(requirement);
    assert.deepEqual(selected, { binary: path.join(binaryRoot, "paperclip-runnerd"), sourceBuild: true });
    const published = await stat(selected.binary);
    assert.equal(published.mode & 0o777, 0o755);
    assert.notDeepEqual(await readFile(selected.binary), oldArtifact);
    assert.equal((await stat(hostTarget)).ino, oldIdentity.ino);
    assert.deepEqual(await readFile(hostTarget), oldArtifact);
    assert.equal(await readFile(manifestPath, "utf8"), manifest);
    for (const [artifact, bytes] of releaseBytes) assert.deepEqual(await readFile(artifact), bytes);
    assert.equal(resolvePackagedRunnerBinary(path.join(packageRoot, "dist")), hostTarget);
    assert.equal(paperclipRunnerBinaryNeedsBuild(requirement), false);
    assert.equal(old.child.exitCode, null);
    assert.equal(old.child.signalCode, null);
    const next = start(selected.binary, hostFixture.freshBuild.exitZeroArgs);
    await next.spawned; await next.closed;
    assert.equal(next.child.exitCode, 0);
  });
});

test("a second spawn error still retires the live old child and removes its fixture", { skip: process.platform === "win32", timeout: 15_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "runnerd-stage-spawn-failure-"));
  let old;
  await assert.rejects(withOwnedChildren(root, async start => {
    old = start("/bin/sleep", ["30"]); await old.spawned;
    const failed = start(path.join(root, "missing-executable"), []);
    await failed.spawned;
  }), { code: "ENOENT" });
  assert.notEqual(old.child.signalCode, null);
  await assert.rejects(stat(root), { code: "ENOENT" });
});

test("failed preparation preserves the published bytes and mode", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "runnerd-stage-failure-"));
  const destination = path.join(root, "paperclip-runnerd");
  try {
    await writeFile(destination, "previous build", { mode: 0o755 });
    const before = await stat(destination);
    await assert.rejects(stageRunnerBinary(path.join(root, "absent-source"), destination), { code: "ENOENT" });
    assert.equal(await readFile(destination, "utf8"), "previous build");
    const after = await stat(destination);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mode, before.mode);
    assert.deepEqual(await readdir(root), ["paperclip-runnerd"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
