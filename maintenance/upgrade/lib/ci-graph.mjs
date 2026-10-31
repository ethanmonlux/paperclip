import { canonicalDigest } from "./digest.mjs";

/**
 * Expected CI check graph for one candidate (R4). The required check set must
 * cover every lane the reviewed workflows will produce for a pull request,
 * derived from the exact workflow blobs, not from a list of checks that
 * happened to succeed. This reads a deliberately small YAML subset; any shape
 * it cannot expand exactly (dynamic matrices, anchors, unnamed matrix jobs,
 * mutable reusable-workflow refs, flow-mapping triggers, ...) makes the graph
 * unsupported, which the admission gate treats as unknown. Trigger syntax is
 * positively validated, never filtered by guesswork (R5), and the graph also
 * pins every workflow file's blob, so a workflow the reader skipped still
 * makes a changed candidate differ from the reviewed graph.
 */
export const CI_GRAPH_SCHEMA = "staple.ci-graph.v1";

// Pull-request activity types that make a workflow run for every new head.
const EVERY_HEAD = "synchronize";
const FILTER_KEYS = new Set(["paths", "paths-ignore", "branches", "branches-ignore"]);
const PR_EVENTS = new Set(["pull_request", "pull_request_target"]);
const PR_CONFIG_KEYS = new Set([...FILTER_KEYS, "types"]);
// An inline value on a pull-request event that still means "no configuration".
const EMPTY_EVENT_VALUES = new Set(["{}", "null", "~"]);
const EVENT_NAME = /^[a-z_]+$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
// GitHub reads only these files in .github/workflows/.
export const WORKFLOW_FILE = /\.ya?ml$/i;

export class UnsupportedGraph extends Error {}
const unsupported = (message) => { throw new UnsupportedGraph(message); };

const indentOf = (line) => line.length - line.trimStart().length;

function stripComment(text) {
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) { if (char === quote) quote = null; continue; }
    if (char === "'" || char === "\"") quote = char;
    else if (char === "#" && (index === 0 || /\s/.test(text[index - 1]))) return text.slice(0, index).trimEnd();
  }
  return text.trimEnd();
}

function scalar(raw, where) {
  const text = stripComment(raw).trim();
  if (/^[|>]/.test(text)) unsupported(`${where}: block scalar`);
  if (/^[&*!]/.test(text)) unsupported(`${where}: YAML anchor, alias or tag`);
  if (text.length >= 2 && (text[0] === "'" || text[0] === "\"") && text.at(-1) === text[0]) return text.slice(1, -1);
  return text;
}

function flowList(raw, where) {
  const text = stripComment(raw).trim();
  if (!text.startsWith("[") || !text.endsWith("]")) return null;
  const inner = text.slice(1, -1).trim();
  if (/[[\]{}]/.test(inner)) unsupported(`${where}: nested flow collection`);
  return inner ? inner.split(",").map((item) => scalar(item, where)) : [];
}

/** Meaningful lines (no blanks or full-line comments) with their indentation. */
function meaningfulLines(text) {
  const lines = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (/^\s*(#|$)/.test(line)) continue;
    lines.push({ indent: indentOf(line), text: line.trim(), number: index + 1, raw: line });
  }
  return lines;
}

/** Anchors, aliases, merge keys and tabs change structure this reader cannot follow. */
function assertPlain(lines, where) {
  for (const line of lines) {
    if (/^\s*\t/.test(line.raw)) unsupported(`${where}:${line.number}: tab indentation`);
    // Quoted text is data (for example inside a run step), not YAML structure.
    const structure = stripComment(line.text).replace(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'/g, "\"\"");
    if (/^(- )?<<\s*:/.test(structure) || /:\s+[&*][\w-]/.test(structure) || /^- [&*][\w-]/.test(structure)) {
      unsupported(`${where}:${line.number}: YAML anchor or alias`);
    }
  }
}

/** Lines belonging to the mapping key at `start` (strictly deeper indentation). */
function blockAfter(lines, start) {
  const block = [];
  for (let index = start + 1; index < lines.length && lines[index].indent > lines[start].indent; index += 1) block.push(lines[index]);
  return block;
}

function keyValue(line) {
  const match = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(line.text);
  return match ? { key: match[1], value: match[2] ?? "" } : null;
}

/** Direct child keys of a block, at its shallowest indentation. */
function childKeys(block, where) {
  if (block.length === 0) return [];
  const indent = block[0].indent;
  const children = [];
  for (const [index, line] of block.entries()) {
    if (line.indent < indent) unsupported(`${where}:${line.number}: inconsistent indentation`);
    if (line.indent !== indent) continue;
    const entry = keyValue(line);
    if (!entry) unsupported(`${where}:${line.number}: expected a mapping key`);
    if (children.some((child) => child.key === entry.key)) unsupported(`${where}:${line.number}: duplicate key ${entry.key}`);
    children.push({ ...entry, line, body: blockAfter(block, index) });
  }
  return children;
}

function blockList(block, where) {
  return block.map((line) => {
    if (!line.text.startsWith("- ")) unsupported(`${where}:${line.number}: expected a list item`);
    return scalar(line.text.slice(2), `${where}:${line.number}`);
  });
}

function listValue(entry, where) {
  if (entry.value) return flowList(entry.value, where) ?? [scalar(entry.value, where)];
  return blockList(entry.body, where);
}

function eventName(raw, where) {
  const name = scalar(raw, where);
  if (!EVENT_NAME.test(name)) unsupported(`${where}: trigger ${JSON.stringify(name)} is not a plain event name`);
  return name;
}

/** A filter or types list on a pull-request event: plain scalars only. */
function triggerList(entry, where) {
  const values = listValue(entry, where);
  for (const value of values) if (/^[[{]/.test(value) || value.includes("${{")) unsupported(`${where}: ${entry.key} value ${JSON.stringify(value)} is not a plain scalar`);
  return values;
}

/**
 * `on:` triggers relevant to pull requests. Every accepted form is decoded
 * exactly: a plain event name, a flow list of names, or a block mapping whose
 * pull-request events carry only the filters and types they document. Anything
 * else is unsupported, so a workflow can never drop out of the graph because
 * its trigger was not understood.
 */
export function parseTriggers(text, where) {
  const lines = meaningfulLines(text);
  // A tab-led line is not YAML indentation this reader can place in a block.
  const tabbed = lines.find((line) => line.raw.startsWith("\t"));
  if (tabbed) unsupported(`${where}:${tabbed.number}: tab indentation`);
  const on = childKeys(lines, where).find((entry) => entry.key === "on");
  if (!on) unsupported(`${where}: no on: trigger`);
  // Only the trigger block is checked for anchors here: workflows that never
  // run for a pull request may use YAML this reader does not follow.
  assertPlain([on.line, ...on.body], where);
  const inlineOn = stripComment(on.value).trim();
  if (inlineOn) {
    if (on.body.length) unsupported(`${where}:${on.line.number}: on: has both an inline value and a block`);
    const names = flowList(inlineOn, `${where}:on`) ?? [inlineOn];
    const triggers = {};
    for (const raw of names) {
      const name = eventName(raw, `${where}:on`);
      if (triggers[name]) unsupported(`${where}:on: duplicate trigger ${name}`);
      triggers[name] = { filters: [] };
    }
    return pick(triggers);
  }
  const events = childKeys(on.body, `${where}:on`);
  if (events.length === 0) unsupported(`${where}: empty on: trigger`);
  const triggers = {};
  for (const event of events) {
    const at = `${where}:on.${event.key}`;
    if (!EVENT_NAME.test(event.key)) unsupported(`${at}: not a plain event name`);
    if (!PR_EVENTS.has(event.key)) continue;
    const inline = stripComment(event.value).trim();
    if (inline && (!EMPTY_EVENT_VALUES.has(inline) || event.body.length)) unsupported(`${at}: inline configuration ${JSON.stringify(inline)}`);
    const config = childKeys(event.body, at);
    for (const entry of config) if (!PR_CONFIG_KEYS.has(entry.key)) unsupported(`${at}: unsupported key ${entry.key}`);
    const filters = config.filter((entry) => FILTER_KEYS.has(entry.key)).map((entry) => `${entry.key}=${triggerList(entry, at).join(",")}`);
    const types = config.find((entry) => entry.key === "types");
    if (types && !triggerList(types, at).includes(EVERY_HEAD)) filters.push(`types=${triggerList(types, at).join(",")}`);
    triggers[event.key] = { filters };
  }
  return pick(triggers);
}

function pick(triggers) {
  return Object.fromEntries(Object.entries(triggers).filter(([name]) => PR_EVENTS.has(name)));
}

function parseMatrix(strategy, where) {
  const matrix = childKeys(strategy.body, where).find((entry) => entry.key === "matrix");
  if (!matrix) return null;
  if (matrix.value) unsupported(`${where}: dynamic matrix ${matrix.value}`);
  const axes = [];
  let include = null;
  for (const entry of childKeys(matrix.body, `${where}.matrix`)) {
    if (entry.key === "include") include = entry;
    else if (entry.key === "exclude") unsupported(`${where}: matrix exclude`);
    else axes.push({ key: entry.key, values: listValue(entry, `${where}.matrix.${entry.key}`) });
  }
  if (include && axes.length > 0) unsupported(`${where}: matrix include combined with axes`);
  let combos;
  if (include) {
    if (include.value) unsupported(`${where}: dynamic matrix include`);
    combos = [];
    const itemIndent = include.body[0]?.indent;
    for (const line of include.body) {
      let { text, indent } = line;
      if (indent === itemIndent) {
        if (!text.startsWith("- ")) unsupported(`${where}:${line.number}: matrix include must be a list`);
        combos.push({});
        text = text.slice(2);
        indent += 2;
      }
      if (indent !== itemIndent + 2) unsupported(`${where}:${line.number}: nested matrix value`);
      const entry = keyValue({ text });
      if (!entry || !entry.value) unsupported(`${where}:${line.number}: matrix include entries must be flat scalars`);
      combos.at(-1)[entry.key] = scalar(entry.value, `${where}:${line.number}`);
    }
  } else {
    combos = [{}];
    for (const axis of axes) combos = combos.flatMap((combo) => axis.values.map((value) => ({ ...combo, [axis.key]: value })));
  }
  for (const combo of combos) for (const value of Object.values(combo)) if (value.includes("${{")) unsupported(`${where}: expression in matrix value`);
  if (combos.length === 0) unsupported(`${where}: empty matrix`);
  return combos;
}

// Recorded for review only; a skipped lane still fails the CI gate.
function conditionText(entry) {
  const value = stripComment(entry.value).trim();
  return value && !/^[|>]/.test(value) ? value : entry.body.map((line) => line.text).join(" ");
}

/** Jobs of one workflow file: id, display name, needs, condition, reusable call, matrix. */
export function parseJobs(text, where) {
  const lines = meaningfulLines(text);
  assertPlain(lines, where);
  const top = childKeys(lines, where);
  const jobsEntry = top.find((entry) => entry.key === "jobs");
  if (!jobsEntry || jobsEntry.value) unsupported(`${where}: no jobs mapping`);
  const jobs = childKeys(jobsEntry.body, `${where}:jobs`).map((entry) => {
    const at = `${where}:jobs.${entry.key}`;
    const fields = childKeys(entry.body, at);
    const field = (key) => fields.find((child) => child.key === key);
    const name = field("name");
    const needs = field("needs");
    const condition = field("if");
    const uses = field("uses");
    const strategy = field("strategy");
    return {
      id: entry.key,
      name: name ? scalar(name.value, `${at}.name`) : null,
      needs: needs ? listValue(needs, `${at}.needs`) : [],
      if: condition ? conditionText(condition) : null,
      uses: uses ? scalar(uses.value, `${at}.uses`) : null,
      matrix: strategy ? parseMatrix(strategy, `${at}.strategy`) : null,
    };
  });
  const ids = new Set(jobs.map((job) => job.id));
  for (const job of jobs) for (const need of job.needs) if (!ids.has(need)) unsupported(`${where}: job ${job.id} needs unknown job ${need}`);
  return jobs;
}

function displayNames(job, where) {
  if (!job.matrix) {
    const name = job.name ?? job.id;
    if (name.includes("${{")) unsupported(`${where}: job ${job.id} name uses an expression outside a matrix`);
    return [{ name }];
  }
  if (!job.name) unsupported(`${where}: matrix job ${job.id} has no explicit name`);
  return job.matrix.map((combo) => ({
    name: job.name.replace(/\$\{\{\s*([^}]*?)\s*\}\}/g, (_, expression) => {
      const match = /^matrix\.([A-Za-z0-9_-]+)$/.exec(expression);
      if (!match || combo[match[1]] === undefined) unsupported(`${where}: job ${job.id} name expression ${expression}`);
      return combo[match[1]];
    }),
    matrix: combo,
  }));
}

/** Expected checks for one workflow, expanding immutable reusable calls one level deep. */
function workflowChecks(workflow, resolveCall, calls) {
  const checks = [];
  const aggregates = [];
  const jobs = parseJobs(workflow.text, workflow.path);
  const namesByJob = new Map();
  const add = (prefix, jobList, where) => {
    for (const job of jobList) {
      const names = displayNames(job, where).map((entry) => ({ ...entry, name: `${prefix}${entry.name}` }));
      namesByJob.set(`${prefix}${job.id}`, names.map((entry) => entry.name));
      for (const entry of names) checks.push({ name: entry.name, workflow: workflow.path, job: `${prefix}${job.id}`, ...(entry.matrix ? { matrix: entry.matrix } : {}) });
    }
  };
  for (const job of jobs) {
    if (!job.uses) { add("", [job], workflow.path); continue; }
    const match = /^([\w.-]+\/[\w.-]+)\/(\.github\/workflows\/[\w.-]+\.ya?ml)@([0-9a-f]+)$/.exec(job.uses);
    if (!match || !FULL_SHA.test(match[3])) unsupported(`${workflow.path}: job ${job.id} calls ${job.uses}, not an immutable full-SHA reusable workflow`);
    if (job.matrix) unsupported(`${workflow.path}: matrix reusable-workflow call ${job.id}`);
    const called = resolveCall(match[1], match[3], match[2]);
    if (!called) unsupported(`${workflow.path}: called workflow ${job.uses} is not available`);
    const where = `${job.uses}`;
    const calledJobs = parseJobs(called.text, where);
    if (calledJobs.some((entry) => entry.uses)) unsupported(`${where}: nested reusable-workflow call`);
    calls.push({ workflow: workflow.path, job: job.id, uses: job.uses, blob: called.blob });
    const prefix = `${job.name ?? job.id} / `;
    add(prefix, calledJobs, where);
    for (const calledJob of calledJobs) if (calledJob.needs.length) aggregates.push({ job: `${prefix}${calledJob.id}`, needs: calledJob.needs.map((need) => `${prefix}${need}`) });
  }
  for (const job of jobs) if (!job.uses && job.needs.length) aggregates.push({ job: job.id, needs: job.needs });
  return {
    checks,
    aggregates: aggregates.flatMap(({ job, needs }) => (namesByJob.get(job) ?? []).map((check) => ({
      check, needs: needs.flatMap((need) => namesByJob.get(need) ?? []).sort(compare),
    }))),
  };
}

// Code-unit order, not locale order, so the graph digest is the same everywhere.
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const byName = (left, right) => compare(left.name ?? left.check ?? left.path, right.name ?? right.check ?? right.path);

/**
 * Build the expected PR check graph. `head` lists every file in the candidate
 * head's .github/workflows/ (pull_request runs those); `base` lists the
 * base-context branch's (pull_request_target runs those, never the head's).
 * Each entry is `{ path, blob, text, mode? }`; `baseContext` names that branch.
 * `resolveCall(repo, sha, path)` returns the pinned reusable workflow's
 * `{ blob, text }` or null. Every listed file is pinned in `files`, whether or
 * not it runs for a pull request.
 */
export function buildCiGraph({ head, base, baseContext, resolveCall }) {
  try {
    const workflows = [];
    const checks = [];
    const aggregates = [];
    const calls = [];
    const files = [];
    const consider = (listed, context, event) => {
      for (const file of listed) {
        files.push({ path: file.path, context, blob: file.blob });
        if (!WORKFLOW_FILE.test(file.path)) continue;
        if (file.mode && file.mode !== "100644" && file.mode !== "100755") unsupported(`${file.path}: workflow file mode ${file.mode} (symlink or non-file)`);
        if (typeof file.text !== "string") unsupported(`${file.path}: workflow text unavailable`);
        const trigger = parseTriggers(file.text, file.path)[event];
        if (!trigger) continue;
        const required = trigger.filters.length === 0;
        workflows.push({ path: file.path, context, blob: file.blob, trigger: event, required, ...(required ? {} : { filters: trigger.filters }) });
        if (!required) continue;
        const result = workflowChecks(file, resolveCall, calls);
        checks.push(...result.checks);
        aggregates.push(...result.aggregates);
      }
    };
    consider(head, "head", "pull_request");
    consider(base, "base", "pull_request_target");
    const names = checks.map((check) => check.name);
    const duplicate = names.find((name, index) => names.indexOf(name) !== index);
    if (duplicate) unsupported(`two expected lanes share the check name ${duplicate}`);
    if (checks.length === 0) unsupported("no required pull-request workflow found");
    return {
      schema: CI_GRAPH_SCHEMA,
      baseContext,
      files: files.sort((left, right) => compare(`${left.context}:${left.path}`, `${right.context}:${right.path}`)),
      workflows: workflows.sort(byName),
      calls: calls.sort((left, right) => compare(left.uses, right.uses)),
      checks: checks.sort(byName),
      aggregates: aggregates.sort(byName),
    };
  } catch (error) {
    if (error instanceof UnsupportedGraph) return { schema: CI_GRAPH_SCHEMA, unsupported: error.message };
    throw error;
  }
}

/**
 * Compare the committed (reviewed) graph with one regenerated from the
 * candidate's actual workflow blobs. Any difference, including a changed blob
 * pin, is unknown until the new graph is reviewed.
 */
export function verifyCiGraph({ committed, regenerated }) {
  if (!regenerated || regenerated.unsupported) return { status: "unknown", detail: `unsupported workflow graph: ${regenerated?.unsupported ?? "not generated"}` };
  if (!committed || committed.schema !== CI_GRAPH_SCHEMA) return { status: "unknown", detail: "no reviewed CI graph committed" };
  if (canonicalDigest(committed) !== canonicalDigest(regenerated)) {
    const blobs = (graph) => new Set([
      ...(graph.files ?? []).map((entry) => `${entry.context}:${entry.path}@${entry.blob}`),
      ...(graph.workflows ?? []).map((entry) => `${entry.path}@${entry.blob}`),
      ...(graph.calls ?? []).map((entry) => `${entry.uses}#${entry.blob}`),
    ]);
    const names = (graph) => new Set((graph.checks ?? []).map((check) => check.name));
    const delta = (from, to) => [...from].filter((entry) => !to.has(entry));
    const changes = [
      ...delta(blobs(regenerated), blobs(committed)).map((entry) => `workflow now ${entry}`),
      ...delta(blobs(committed), blobs(regenerated)).map((entry) => `workflow was ${entry}`),
      ...delta(names(regenerated), names(committed)).map((entry) => `new lane ${entry}`),
      ...delta(names(committed), names(regenerated)).map((entry) => `lane gone ${entry}`),
    ];
    return { status: "unknown", detail: `candidate workflows differ from the reviewed CI graph: ${changes.join("; ") || "graph content changed"}` };
  }
  return { status: "pass", detail: `${committed.checks.length} expected lanes`, graph: committed };
}
