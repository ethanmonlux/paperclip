/** Authored architecture text. Keep each node's sources current when changing its explanation. */
export interface AtlasNode {
  id: string;
  title: string;
  summary: string;
  workings: string;
  evidence: string;
  paths: string[];
}
export interface AtlasChapter { id: string; title: string; introduction: string; nodes: AtlasNode[] }

/** An illustrative route through the existing native task and delivery records. */
export const atlasOverviewStages = [
  { title: "Request", detail: "Ethan asks for an Item artwork button that opens the explorer in one tap.", owner: "Ethan sets the outcome", node: "brief" },
  { title: "Clear success criteria", detail: "The task says what must work: phone navigation, safe Back and Home, current artwork, and access checks.", owner: "Coordinator records acceptance", node: "assignment" },
  { title: "Implementation", detail: "An assigned engineer changes the task branch and links a reviewable PR.", owner: "Engineer builds", node: "branch" },
  { title: "Independent review and tests", detail: "CI checks the candidate; a separate reviewer checks behavior and sends corrections back to the engineer.", owner: "CI and reviewer check", node: "review" },
  { title: "Delivered usable result", detail: "After merge and nightly activation, Ethan opens the real phone route and records what works.", owner: "Coordinator verifies delivery", node: "acceptance" },
] as const;

export const atlasOverviewPaths = [
  { title: "Why trust the result?", summary: "Read the exact-head checks, independent review, phone evidence and remaining unknowns.", nodes: ["ci", "review", "acceptance"] },
  { title: "What happens when something breaks?", summary: "A failed check or stalled run returns to its owner for a focused fix, retry or visible escalation.", nodes: ["correction", "retry", "notifications"] },
  { title: "How does the system change safely?", summary: "Upstream changes use small local patches; the nightly watcher keeps backup and rollback evidence.", nodes: ["candidate", "backup", "rollback"] },
] as const;

const node = (id: string, title: string, summary: string, workings: string, evidence: string, paths: string[]): AtlasNode => ({ id, title, summary, workings, evidence, paths });
const task = ["server/src/routes/issues", "server/src/services/issues", "server/src/services/issue", "packages/db/src/schema/issues"];
const native = ["server/src/services/native-runtime/", "packages/paperclip-runner/"];
const github = ["server/src/services/staple-console", "server/src/services/github", ".github/workflows/"];
const upgrade = ["server/src/services/maintenance-hold", "server/src/services/managed-update", "scripts/staple", ".github/workflows/"];
const integrations = ["server/src/services/connections", "server/src/routes/apps", "server/src/services/git-credentials"];
export const atlasChapters: AtlasChapter[] = [
  { id: "boundary", title: "Staple and Paperclip", introduction: "Where the product ends and the operating layer begins.", nodes: [
    node("foundation", "Paperclip foundation", "Paperclip owns the company control plane.", "Companies, agents, tasks, approvals and runs persist in Paperclip. Staple adds the operating practices and founder-facing view around them.", "Inspect the company, task and run APIs for current state.", ["server/src/routes/companies", ...task]),
    node("staple", "Staple layer", "Staple uses native Paperclip work records and execution.", "The Workflow contract chooses native tasks, sessions, monitoring and recovery before custom machinery.", "Execution Contract Standard and Workflow operating contract define current policy.", native),
    node("company", "Company scope", "Every Atlas view belongs to the selected company.", "The Console endpoint checks company access and filters task evidence by the reader's issue permissions.", "Try another company's route and a private task; neither should leak evidence.", ["server/src/routes/staple-console", "server/src/services/staple-console"]),
    node("roles", "People and agents", "A configured agent is a role, not proof that work ran.", "The roster describes current configuration; run records establish actual execution.", "Compare Agents with the recent run feed.", ["server/src/routes/agents", "server/src/services/heartbeat"]),
    node("authority", "Sources of truth", "Each system owns a different fact.", "Linear owns scope; GitHub owns source and CI; Paperclip owns tasks and runs; the installer and runtime own observed deployment.", "Open the linked task, PR and installed revision separately.", ["server/src/services/staple-console", "ui/src/pages/StapleConsole"]),
    node("visibility", "Founder visibility", "Console shows work state; Atlas explains how it works.", "The board reads authorized evidence and polls while visible. This Atlas links explanations to live Console facts.", "Open Console for current cards and Atlas for the system model.", ["ui/src/pages/StapleConsole", "server/src/services/staple-console"]),
  ]},
  { id: "work", title: "Work execution", introduction: "How approved work becomes a run and a durable result.", nodes: [
    node("brief", "Useful brief", "An approved task states the outcome and acceptance.", "The issue and linked current contracts define scope; the plan records the next steps.", "Read the owning task and its plan document.", task),
    node("assignment", "Assignment", "One task has one current assignee.", "Native assignment and checkout decide which agent may write; a queue entry alone is not active work.", "Check assignee, checkout and active run separately.", task),
    node("checkout", "Checkout", "Atomic checkout claims task work.", "The run-scoped agent claims the issue before editing; conflicts must not create two writers.", "A conflicting checkout should fail without changing ownership.", task),
    node("workspace", "Isolated workspace", "A task works on its own branch and checkout.", "Separate workspaces preserve sibling work while integration is serialized.", "Compare branch and worktree identity with the task's PR.", ["server/src/services/execution-workspace", ...native]),
    node("session", "Native session", "A run invokes a replaceable provider session.", "Paperclip prepares context, starts or resumes the adapter and records the run lifecycle.", "A run record shows actual provider, start and result.", native),
    node("handoff", "Handoff", "A handoff keeps task context with its next owner.", "Assignee, branch, PR, artifacts and blockers remain attached to native task records.", "Inspect the task feed after reassignment.", ["server/src/services/issue", "server/src/services/heartbeat"]),
    node("progress", "Progress evidence", "Movement means a useful state change, not a busy signal.", "Console combines task, run and PR evidence and labels waits explicitly.", "Compare latest run output with the task's next result.", ["server/src/services/staple-console", "packages/shared/src/staple-console"]),
  ]},
  { id: "delivery", title: "Review, CI and delivery", introduction: "How source becomes reviewed, integrated and eventually observed.", nodes: [
    node("branch", "Task branch", "Source edits stay on the task branch.", "A reviewable PR captures a stable head while other work continues separately.", "Open the PR head and owning issue.", github),
    node("ci", "CI", "Checks validate the exact candidate revision.", "A green previous head does not establish a green updated head; base movement requires a refreshed check.", "Read checks on the PR's current head.", github),
    node("review", "Independent review", "A separate reviewer assesses the candidate source.", "The current review contract normally requires a cross-model reviewer; STA-289 has a founder-approved exception for a separate Codex reviewer.", "The review records head and P0–P3 findings.", ["rules/pull-request-review", ...github]),
    node("correction", "Correction round", "Required fixes return the work to Build.", "Focused verification addresses each finding without restarting broad review rounds.", "Check the changed hunk, linked finding and exact-head CI.", github),
    node("merge", "Serialized merge", "Coordinator integrates approved source.", "For Staple work, zero P0/P1 and green exact-head CI allow merge; every P2 becomes a task.", "GitHub merge commit is source integration evidence.", github),
    node("installed", "Installed build", "Merge does not prove installation.", "The running server advertises its build revision; the managed nightly watcher handles installation.", "Compare merged revision with the running revision.", upgrade),
    node("acceptance", "Observed acceptance", "A useful outcome needs actual behavior evidence.", "UI and runtime observations follow installation; a test or merge alone is narrower proof.", "Record the phone view and native route behavior after activation.", ["ui/src/pages/StapleConsole", ...upgrade]),
  ]},
  { id: "upgrades", title: "Nightly upgrades", introduction: "Source integration and managed activation have different clocks.", nodes: [
    node("watcher", "Upgrade watcher", "The watcher is the only Staple install path.", "Quiet nightly activation is owned outside agent runs; agents do not manually restart the service.", "Read the watcher receipt and running revision.", upgrade),
    node("candidate", "Candidate source", "Merged source waits for the next managed attempt.", "The watcher selects eligible source only after its own checks and schedule.", "Compare main and installed revisions.", upgrade),
    node("backup", "Backup", "A managed update preserves a recovery point.", "The installer is responsible for backup before activating a candidate.", "Inspect the update receipt for backup status.", upgrade),
    node("activation", "Activation", "The running process establishes the installed revision.", "A successful source build still needs the watcher to start and verify the candidate.", "Use the runtime revision, not PR state, for installed evidence.", upgrade),
    node("rollback", "Rollback", "A failed candidate should restore the prior usable build.", "The managed path records failure and recovery rather than calling the candidate live.", "Inspect failed receipt and restored running revision.", upgrade),
    node("freshness", "Freshness boundary", "Atlas source and observed behavior can differ.", "The Atlas compares its authored build with latest source and shows observation time independently.", "Look at source, installed and observed values above each chapter.", ["server/src/services/staple-console", ...upgrade]),
  ]},
  { id: "recovery", title: "Recovery", introduction: "How interrupted or stalled work regains a safe continuation.", nodes: [
    node("wait", "Wait", "A wait has a condition and deadline.", "Native blockers, interactions and monitors make the next wake durable.", "Open the task's blocker or monitor, not a shell session.", ["server/src/services/issue", "server/src/services/monitor"]),
    node("monitor", "Monitor", "A monitor checks a concrete future condition.", "The native scheduler wakes the task when its deadline or signal is due.", "Check next-check time and last result.", ["server/src/services/monitor", "server/src/services/work-scheduler"]),
    node("retry", "Retry", "Recover transient failure with a bounded retry.", "Repeated failure should change method or hand off while preserving context.", "Inspect run attempts and recovery action.", ["server/src/services/heartbeat", ...native]),
    node("provider", "Provider replacement", "A new session can continue the same task.", "Provider failure does not transfer task authority; new execution must respect existing assignment and writer ownership.", "Compare old and new run attribution on one issue.", native),
    node("hold", "Maintenance hold", "A hold pauses affected work visibly.", "The current hold state comes from Paperclip and is shown without implying progress.", "Console's maintenance banner reports the observed hold.", ["server/src/services/maintenance-hold", "server/src/services/staple-console"]),
    node("resume", "Durable resume", "The task carries its next action across runs.", "Issue state, documents and PR linkage survive provider or process replacement.", "Reopen the task and verify the next agent has branch and PR context.", ["server/src/services/issue", ...native]),
  ]},
  { id: "integrations", title: "Integrations", introduction: "Connected systems contribute evidence without becoming the task authority.", nodes: [
    node("linear", "Linear", "Linear owns product scope and decisions.", "Current contracts and the owning issue set acceptance; integration links can reference native tasks.", "Open the current Linear requirement from the task.", integrations),
    node("github", "GitHub", "GitHub owns branch, PR, check and merge facts.", "The Console reads PR state using existing authorized credentials and labels unavailable checks unknown.", "Open the exact PR and its checks.", github),
    node("secrets", "Credentials", "Existing connection grants bound provider access.", "Atlas uses the Console's viewer-scoped GitHub read; missing access leaves source comparison unknown.", "Revoke a grant and verify the view no longer claims fresh GitHub data.", integrations),
    node("notifications", "Founder notices", "A notice carries a real decision or exhausted exception.", "Task interactions remain the answer authority; Atlas only links to them.", "Open the linked interaction and check its state.", ["server/src/services/notifications", "server/src/services/issue"]),
    node("routines", "Routines", "Native routines schedule recurring approved work.", "A routine is not an alternate task authority or extra Atlas scheduler.", "Check configured routine and last run before calling it active.", ["server/src/services/routines", "server/src/routes/routines"]),
    node("maps", "Capability maps", "A map explains what the system can do.", "Feature and access maps describe paths; the capability registry links claims to issues and acceptance evidence.", "Follow a capability claim to its task and proof.", ["maps/feature-map/", "maps/agent-access-map/", "server/src/services/staple-console"]),
  ]},
  { id: "operations", title: "Operations", introduction: "Daily signals that keep a founder oriented.", nodes: [
    node("console", "Console", "The board shows live work and attention.", "Its authorized company feed combines task, run, PR and capability evidence.", "Open Console and inspect the current observation time.", ["ui/src/pages/StapleConsole", "server/src/services/staple-console"]),
    node("agents", "Configured agents", "Roster state is configuration evidence.", "An agent entry does not prove a run; active work appears in run records.", "Compare the roster with current runs.", ["server/src/routes/agents", "server/src/services/staple-console"]),
    node("waiting", "Waiting work", "Blocking tasks and interactions name the next condition.", "Console cards show their blocker and founder answer link when present.", "Tap a waiting chip to its source task.", ["server/src/services/staple-console", "ui/src/pages/StapleConsole"]),
    node("receipts", "Update receipts", "Receipts show what an upgrade attempted.", "The next nightly event and running revision are separate facts.", "Compare watcher result with health revision.", upgrade),
    node("stale", "Stale data", "A failed refresh keeps last-good evidence visibly stale.", "The client pauses hidden polling and greys data after two minutes; source comparison failures say unknown.", "Disable the API and confirm old data is labelled stale.", ["ui/src/pages/StapleConsole", "ui/src/pages/SystemAtlas"]),
    node("access", "Access boundary", "A viewer sees only authorized company evidence.", "The server checks company membership and readable tasks before building the board.", "Test foreign-company and private-task requests.", ["server/src/routes/staple-console", "server/src/services/staple-console"]),
    node("next", "Next action", "The task's next durable action matters more than transport activity.", "A monitor, interaction or assignment carries continuation; a prose promise does not.", "Open the task's current wait or assigned run.", ["server/src/services/issue", "server/src/services/staple-console"]),
  ]},
];

export const atlasWalkthroughs = [
  ["Start approved work", "brief", "assignment", "checkout", "workspace", "session"],
  ["Take a change through review", "branch", "ci", "review", "correction", "merge"],
  ["Observe an installation", "merge", "candidate", "watcher", "activation", "acceptance"],
  ["Recover a failed update", "candidate", "backup", "rollback", "receipts"],
  ["Resume a stalled task", "wait", "monitor", "retry", "resume"],
  ["Replace a failed provider", "provider", "handoff", "session", "resume"],
  ["Answer a founder decision", "notifications", "waiting", "next"],
  ["Trace a capability", "maps", "authority", "console"],
  ["Check a source change", "branch", "freshness", "stale"],
  ["Check access", "company", "access", "secrets"],
  ["Read current operations", "console", "agents", "hold", "receipts"],
] as const;

export function atlasAffectedNodes(changedPaths: readonly string[]): string[] {
  return atlasChapters.flatMap((chapter) => chapter.nodes)
    .filter((item) => changedPaths.some((path) => item.paths.some((prefix) => path.startsWith(prefix))))
    .map((item) => item.id);
}
