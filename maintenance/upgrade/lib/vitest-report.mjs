import path from "node:path";

/**
 * Upstream-only outcomes. Only `upstream-passes` can support retiring a patch,
 * and even then only together with an independent review. `upstream-fails`
 * means an assertion in the evidence test failed against upstream. Everything we
 * cannot prove (load or API-mismatch errors, skips, missing tests, odd exits)
 * is `unknown`.
 */
export const OUTCOMES = Object.freeze(["upstream-passes", "upstream-fails", "unknown"]);

const ASSERTION_FAILURE = /^\s*AssertionError\b/;

function isAssertionFailure(assertion) {
  const messages = Array.isArray(assertion.failureMessages) ? assertion.failureMessages : [];
  return messages.length > 0 && messages.every((message) => typeof message === "string" && ASSERTION_FAILURE.test(message));
}

function normalize(file) {
  return file.split(path.sep).join("/");
}

function findSuite(report, root, file) {
  const wanted = normalize(path.resolve(root, file));
  return report.testResults.find((suite) => typeof suite?.name === "string" && normalize(path.resolve(root, suite.name)) === wanted);
}

/**
 * Classify a Vitest JSON report for exactly the declared evidence files.
 * @param {{ report: unknown, exitCode: number | null, root: string, testFiles: string[], requiredTests?: string[] }} input
 */
export function classifyVitestReport({ report, exitCode, root, testFiles, requiredTests = [] }) {
  const reasons = [];
  const counts = { passed: 0, failed: 0, skipped: 0, total: 0 };
  const result = (outcome) => ({ outcome, reasons, counts });
  if (!report || typeof report !== "object" || !Array.isArray(report.testResults)) {
    reasons.push("report-missing-or-malformed");
    return result("unknown");
  }
  const considered = [];
  const allInFiles = [];
  for (const file of testFiles) {
    const suite = findSuite(report, root, file);
    if (!suite) { reasons.push(`not-executed:${file}`); continue; }
    const assertions = Array.isArray(suite.assertionResults) ? suite.assertionResults : [];
    if (assertions.length === 0) {
      reasons.push(suite.message ? `suite-load-failure:${file}` : `no-tests:${file}`);
      continue;
    }
    if (suite.message && suite.status === "failed" && assertions.every((a) => a.status === "passed")) {
      // A suite-level error (hook failure, unhandled rejection) with otherwise
      // green assertions is not a clean pass.
      reasons.push(`suite-error:${file}`);
    }
    for (const assertion of assertions) allInFiles.push({ file, assertion });
  }
  if (reasons.length > 0) return result("unknown");

  if (requiredTests.length > 0) {
    for (const title of requiredTests) {
      const matches = allInFiles.filter(({ assertion }) => typeof assertion.fullName === "string" && assertion.fullName.includes(title));
      if (matches.length === 0) reasons.push(`required-test-missing:${title}`);
      considered.push(...matches);
    }
    if (reasons.length > 0) return result("unknown");
  } else {
    considered.push(...allInFiles);
  }

  for (const { assertion } of new Set(considered)) {
    counts.total += 1;
    if (assertion.status === "passed") counts.passed += 1;
    else if (assertion.status === "failed") counts.failed += 1;
    else counts.skipped += 1;
  }
  if (counts.skipped > 0) {
    reasons.push("skipped-or-pending-tests");
    return result("unknown");
  }
  if (counts.failed > 0) {
    // Only an assertion failure shows that upstream lacks the behavior. A
    // TypeError, missing export, timeout or crash means the fork's test cannot
    // exercise upstream as written, which proves nothing about the behavior.
    const nonAssertion = [...new Set(considered)]
      .filter(({ assertion }) => assertion.status === "failed" && !isAssertionFailure(assertion))
      .map(({ assertion }) => `non-assertion-failure:${assertion.fullName}`);
    if (nonAssertion.length > 0) {
      reasons.push(...nonAssertion);
      return result("unknown");
    }
    reasons.push("evidence-test-failed");
    return result("upstream-fails");
  }
  if (exitCode !== 0) {
    reasons.push(`nonzero-exit:${exitCode}`);
    return result("unknown");
  }
  return result("upstream-passes");
}
