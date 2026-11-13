// One Vitest retry is a PR-only safety net for contention flakes: a test that
// fails once under a loaded runner otherwise forces a whole-workflow re-run.
// Every pass that needed a retry is surfaced by scripts/ci/retry-reporter.mjs.
//
// PR CI is the pr.yml caller of pr-trusted.yml. Reusable workflows inherit the
// caller's GITHUB_WORKFLOW, so release, cloud-readiness, master and local runs
// keep retry 0. PAPERCLIP_VITEST_RETRY overrides the default in any context;
// set it to 0 to switch retries off, or to N for a local reproduction.
//
// Staple certification (staple-certify.yml, STA-223) calls the same
// pr-trusted.yml to certify a master commit, so it gets the same lanes and
// retry as PR CI. Under any other name its general shards would also run the
// cargo-dependent native-runner suites without a Runner binary and fail.
export const vitestRetryEnvName = "PAPERCLIP_VITEST_RETRY";
export const prWorkflowName = "PR";
export const prLaneWorkflowNames = Object.freeze([prWorkflowName, "Staple certification"]);
export const prDefaultVitestRetry = 1;

export function isPrLaneWorkflow(env = process.env) {
  return prLaneWorkflowNames.includes(env.GITHUB_WORKFLOW);
}

export function vitestRetryCount(env = process.env) {
  const configured = env[vitestRetryEnvName]?.trim();
  if (configured) {
    const parsed = Number(configured);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error(`${vitestRetryEnvName} must be a non-negative integer. Received "${configured}".`);
    }
    return parsed;
  }
  return env.GITHUB_ACTIONS === "true" && isPrLaneWorkflow(env) ? prDefaultVitestRetry : 0;
}

export function vitestRetryArgs(env = process.env) {
  const count = vitestRetryCount(env);
  return count > 0 ? [`--retry=${count}`] : [];
}

// Report retried passes in any GitHub Actions job, and wherever retry is on.
export function retryReporterEnabled(env = process.env) {
  return env.GITHUB_ACTIONS === "true" || vitestRetryCount(env) > 0;
}
