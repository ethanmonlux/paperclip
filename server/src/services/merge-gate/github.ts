/** GitHub reads and the exact-head merge for the protected-main gate (FAC-840 B). */
import { ghFetch } from "../github-fetch.js";
import type { MergeGateCheck, PullRequestFileDiff } from "./policy.js";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const GITHUB_TIMEOUT_MS = 10_000;
const PAGE_SIZE = 100;
const MAX_CHECK_PAGES = 10;
const MAX_FILE_PAGES = 30;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export class GitHubMergeGateError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
  }
}

export interface GatePullRequest {
  state: string;
  merged: boolean;
  draft: boolean;
  headSha: string;
  headRef: string | null;
  baseRef: string;
  mergeable: boolean | null;
  mergeableState: string | null;
}

export interface GateCompare {
  status: string;
  aheadBy: number;
  behindBy: number;
  totalCommits: number;
  commits: Array<{ sha: string; parentCount: number; message?: string | null }>;
  files: PullRequestFileDiff[];
  /** False when GitHub truncated the commit or file list. */
  complete: boolean;
}

export interface MergeGateGitHub {
  pullRequest(pullNumber: number): Promise<GatePullRequest>;
  branchHead(branch: string): Promise<string>;
  compare(base: string, head: string): Promise<GateCompare>;
  pullRequestFiles(pullNumber: number): Promise<PullRequestFileDiff[] | null>;
  checks(sha: string): Promise<{ checks: MergeGateCheck[]; complete: boolean }>;
  merge(pullNumber: number, input: { sha: string; method: "merge" | "squash" | "rebase"; title: string }): Promise<{ merged: boolean; sha: string | null; message: string }>;
}

export function createMergeGateGitHub(input: { repo: string; token: string; fetchImpl?: FetchLike }): MergeGateGitHub {
  const fetchImpl = input.fetchImpl ?? ghFetch;
  const base = `https://api.github.com/repos/${input.repo}`;
  const request = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const response = await fetchImpl(`${base}${path}`, {
      method: init.method ?? "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${input.token}`,
        "x-github-api-version": "2022-11-28",
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    const body = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      const message = readString(asRecord(body)?.message) ?? `HTTP ${response.status}`;
      throw new GitHubMergeGateError(`GitHub ${response.status} for ${path.split("?")[0]}: ${message.slice(0, 200)}`, response.status);
    }
    return body;
  };
  const sha = (value: string) => encodeURIComponent(value);
  const toFile = (raw: unknown): PullRequestFileDiff => {
    const file = asRecord(raw);
    return {
      filename: readString(file?.filename) ?? "",
      status: readString(file?.status) ?? "modified",
      blobSha: readString(file?.sha),
      patch: readString(file?.patch),
    };
  };

  return {
    async pullRequest(pullNumber) {
      const pr = asRecord(await request(`/pulls/${pullNumber}`));
      return {
        state: readString(pr?.state) ?? "unknown",
        merged: pr?.merged === true || Boolean(readString(pr?.merged_at)),
        draft: pr?.draft === true,
        headSha: readString(asRecord(pr?.head)?.sha) ?? "",
        headRef: readString(asRecord(pr?.head)?.ref),
        baseRef: readString(asRecord(pr?.base)?.ref) ?? "main",
        mergeable: typeof pr?.mergeable === "boolean" ? pr.mergeable : null,
        mergeableState: readString(pr?.mergeable_state),
      };
    },
    async branchHead(branch) {
      const result = asRecord(await request(`/branches/${encodeURIComponent(branch)}`));
      const head = readString(asRecord(result?.commit)?.sha);
      if (!head) throw new GitHubMergeGateError(`GitHub returned no head for ${branch}`, null);
      return head;
    },
    async compare(from, to) {
      const result = asRecord(await request(`/compare/${sha(from)}...${sha(to)}?per_page=${PAGE_SIZE}`));
      const commits = (Array.isArray(result?.commits) ? result.commits : []).map(raw => {
        const commit = asRecord(raw);
        return { sha: readString(commit?.sha) ?? "", parentCount: Array.isArray(commit?.parents) ? commit.parents.length : 1,
          message: readString(asRecord(commit?.commit)?.message) };
      });
      const files = (Array.isArray(result?.files) ? result.files : []).map(toFile);
      const totalCommits = readNumber(result?.total_commits) ?? commits.length;
      return {
        status: readString(result?.status) ?? "unknown",
        aheadBy: readNumber(result?.ahead_by) ?? 0,
        behindBy: readNumber(result?.behind_by) ?? 0,
        totalCommits,
        commits,
        files,
        // GitHub caps compare at 250 commits and 300 files.
        complete: totalCommits <= commits.length && files.length < 300,
      };
    },
    async pullRequestFiles(pullNumber) {
      const files: PullRequestFileDiff[] = [];
      for (let page = 1; page <= MAX_FILE_PAGES; page++) {
        const batch = await request(`/pulls/${pullNumber}/files?per_page=${PAGE_SIZE}&page=${page}`);
        const rows = Array.isArray(batch) ? batch : [];
        files.push(...rows.map(toFile));
        if (rows.length < PAGE_SIZE) return files;
      }
      return null;
    },
    async checks(headSha) {
      const checks: MergeGateCheck[] = [];
      let complete = true;
      let total = 0;
      for (let page = 1; ; page++) {
        const result = asRecord(await request(`/commits/${sha(headSha)}/check-runs?per_page=${PAGE_SIZE}&page=${page}`));
        const rows = Array.isArray(result?.check_runs) ? result.check_runs : [];
        total = readNumber(result?.total_count) ?? total;
        for (const raw of rows) {
          const run = asRecord(raw);
          checks.push({ kind: "check_run", name: readString(run?.name) ?? "check", status: readString(run?.status) ?? "queued", conclusion: readString(run?.conclusion),
            headSha: readString(run?.head_sha), checkSuiteId: readNumber(asRecord(run?.check_suite)?.id), checkRunId: readNumber(run?.id) });
        }
        if (rows.length < PAGE_SIZE) break;
        if (page >= MAX_CHECK_PAGES) { complete = false; break; }
      }
      if (checks.length < total) complete = false;
      for (let page = 1; ; page++) {
        const result = asRecord(await request(`/actions/runs?head_sha=${sha(headSha)}&per_page=${PAGE_SIZE}&page=${page}`));
        const rows = Array.isArray(result?.workflow_runs) ? result.workflow_runs : [];
        for (const raw of rows) {
          const run = asRecord(raw);
          checks.push({ kind: "workflow_run", name: readString(run?.name) ?? "workflow", status: readString(run?.status) ?? "queued", conclusion: readString(run?.conclusion),
            headSha: readString(run?.head_sha), checkSuiteId: readNumber(run?.check_suite_id),
            workflowPath: readString(run?.path)?.split("@", 1)[0] ?? null, runId: readNumber(run?.id),
            runAttempt: readNumber(run?.run_attempt), createdAt: readString(run?.created_at) });
        }
        if (rows.length < PAGE_SIZE) break;
        if (page >= MAX_CHECK_PAGES) { complete = false; break; }
      }
      return { checks, complete };
    },
    async merge(pullNumber, mergeInput) {
      const result = asRecord(await request(`/pulls/${pullNumber}/merge`, {
        method: "PUT",
        // `sha` makes GitHub refuse the merge if the head moved after the gate read it.
        body: { sha: mergeInput.sha, merge_method: mergeInput.method, commit_title: mergeInput.title },
      }));
      return { merged: result?.merged === true, sha: readString(result?.sha), message: readString(result?.message) ?? "" };
    },
  };
}

