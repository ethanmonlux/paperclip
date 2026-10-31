import assert from "node:assert/strict";
import test from "node:test";
import { classifyVitestReport } from "../lib/vitest-report.mjs";

const root = "/repo";
const file = "pkg/a.test.ts";
const suite = (assertionResults, extra = {}) => ({ testResults: [{ name: `${root}/${file}`, status: "passed", message: "", assertionResults, ...extra }] });
const passed = (fullName) => ({ fullName, status: "passed" });
const failed = (fullName) => ({ fullName, status: "failed", failureMessages: ["expected"] });

test("passes only when every considered evidence test passes and the run exits 0", () => {
  const result = classifyVitestReport({ report: suite([passed("x keeps output")]), exitCode: 0, root, testFiles: [file] });
  assert.equal(result.outcome, "upstream-passes");
  assert.deepEqual(result.counts, { passed: 1, failed: 0, skipped: 0, total: 1 });
});

test("a failing evidence assertion means upstream does not demonstrate the behavior", () => {
  const result = classifyVitestReport({ report: suite([passed("a"), failed("b")]), exitCode: 1, root, testFiles: [file] });
  assert.equal(result.outcome, "upstream-fails");
});

test("compile/import failures, missing files and empty suites are unknown, never fixed", () => {
  assert.equal(classifyVitestReport({ report: suite([], { status: "failed", message: "Failed to load url ./parse" }), exitCode: 1, root, testFiles: [file] }).outcome, "unknown");
  assert.equal(classifyVitestReport({ report: suite([]), exitCode: 0, root, testFiles: [file] }).outcome, "unknown");
  assert.equal(classifyVitestReport({ report: { testResults: [] }, exitCode: 0, root, testFiles: [file] }).reasons[0], `not-executed:${file}`);
  assert.equal(classifyVitestReport({ report: null, exitCode: 0, root, testFiles: [file] }).outcome, "unknown");
});

test("skipped or todo evidence is unknown", () => {
  const result = classifyVitestReport({ report: suite([passed("a"), { fullName: "b", status: "skipped" }]), exitCode: 0, root, testFiles: [file] });
  assert.equal(result.outcome, "unknown");
  assert.deepEqual(result.reasons, ["skipped-or-pending-tests"]);
});

test("required tests must all be present; unrelated tests do not decide the outcome", () => {
  const report = suite([passed("suite required one"), failed("unrelated"), { fullName: "other skipped", status: "skipped" }]);
  assert.equal(classifyVitestReport({ report, exitCode: 0, root, testFiles: [file], requiredTests: ["required one"] }).outcome, "upstream-passes");
  const missing = classifyVitestReport({ report, exitCode: 0, root, testFiles: [file], requiredTests: ["required one", "renamed"] });
  assert.equal(missing.outcome, "unknown");
  assert.deepEqual(missing.reasons, ["required-test-missing:renamed"]);
});

test("green assertions with a suite-level error or a nonzero exit are unknown", () => {
  assert.equal(classifyVitestReport({ report: suite([passed("a")], { status: "failed", message: "afterAll hook failed" }), exitCode: 1, root, testFiles: [file] }).outcome, "unknown");
  assert.equal(classifyVitestReport({ report: suite([passed("a")]), exitCode: 1, root, testFiles: [file] }).outcome, "unknown");
  assert.equal(classifyVitestReport({ report: suite([passed("a")]), exitCode: null, root, testFiles: [file] }).outcome, "unknown");
});
