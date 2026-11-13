import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, LayoutDashboard } from "lucide-react";
import {
  STAPLE_CONSOLE_POLL_MS,
  formatStapleConsoleDuration,
  stapleConsoleFreshness,
  stapleConsoleHeaderCounts,
  stapleConsolePlainText,
  stapleConsolePrStatusText,
  stapleConsoleSummaryLine,
  type StapleConsoleAttentionItem,
  type StapleConsoleBoard,
  type StapleConsoleCapability,
  type StapleConsoleCard,
  type StapleConsoleCardStep,
  type StapleConsoleClaim,
  type StapleConsoleClaimState,
  type StapleConsoleProofPullRequest,
  type StapleConsoleStepCell,
  type StapleConsoleUpgradePhase,
  type StapleConsoleUpgradeStageCell,
  type StapleConsoleUpgradeStatus,
  STAPLE_UPGRADE_STAGE_LABELS,
  STAPLE_UPGRADE_STAGE_SHORT,
  stapleUpgradeDrainText,
} from "@paperclipai/shared/staple-console";
import { Link } from "@/lib/router";
import { stapleConsoleApi } from "../api/staple-console";
import { EmptyState } from "../components/EmptyState";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { cn } from "../lib/utils";

/**
 * Staple Console (FAC-620 v2): read-only, phone-first founder board in progressive depth.
 * Level 1 answers "is anything stalled or waiting on me?", Level 2 "what can the system do
 * now?", Level 3 "what is going on?" (collapsed workstream cards) and Level 4 "show me the
 * proof". All state comes from `GET /companies/:id/staple-console`; this page only renders
 * and polls.
 */

const STEP_LABELS: Record<StapleConsoleCardStep, string> = {
  queued: "Queued",
  build: "Build",
  ci: "CI",
  review: "Review",
  merged: "Merged",
  done: "Done",
};

const CORAL = "border-[#f0714f] bg-[#f0714f]/10";

const CLAIM_DOT: Record<StapleConsoleClaimState, string> = {
  green: "bg-emerald-500",
  blue: "bg-sky-500",
  red: "bg-red-500",
};

function useDocumentVisible() {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/** One muted token for a value the board does not know, never a sentence. */
function Unknown() {
  return <span className="text-muted-foreground" data-testid="staple-console-unknown">unknown</span>;
}

function since(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? formatStapleConsoleDuration(now - parsed) : null;
}

function clock(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
}

function Dot({ state, className }: { state: StapleConsoleClaimState; className?: string }) {
  return <span aria-hidden className={cn("inline-block h-2 w-2 shrink-0 rounded-full", CLAIM_DOT[state], className)} />;
}

function Disclosure({
  open,
  onToggle,
  label,
  children,
  testId,
  className,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  children: ReactNode;
  testId?: string;
  className?: string;
}) {
  const Icon = open ? ChevronDown : ChevronRight;
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={label}
      onClick={onToggle}
      data-testid={testId}
      className={cn("flex w-full items-center gap-2 text-left", className)}
    >
      {children}
      <Icon aria-hidden className="ml-auto h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Cards (Level 3) and their proof (Level 4)

function StepBar({ steps }: { steps: StapleConsoleStepCell[] }) {
  return (
    <ol className="grid grid-cols-5 gap-1" aria-label="Workflow step">
      {steps.map((cell) => (
        <li
          key={cell.step}
          aria-current={cell.state === "current" ? "step" : undefined}
          className={cn(
            "min-w-0 truncate rounded px-1 py-0.5 text-center text-[10px] leading-tight",
            cell.state === "done" && "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300",
            cell.state === "current" && "bg-sky-500 font-semibold text-white",
            cell.state === "todo" && "bg-muted text-muted-foreground",
            cell.state === "skipped" && "border border-dashed border-muted-foreground/40 text-muted-foreground",
          )}
        >
          {STEP_LABELS[cell.step]}
        </li>
      ))}
    </ol>
  );
}

function cardCaption(card: StapleConsoleCard) {
  const parts = [STEP_LABELS[card.step]];
  if (card.round > 1) parts.push(`round ${card.round}`);
  return { parts, owner: card.ownerName };
}

function cardSecondary(card: StapleConsoleCard) {
  const pr = card.pullRequests[0];
  return pr ? `${card.identifier} · #${pr.label.split("#").pop()}` : card.identifier;
}

function RuntimeLine({ card, now }: { card: StapleConsoleCard; now: number }) {
  const running = since(card.currentRunStartedAt, now);
  const active = since(card.lastActivityAt, now);
  const inStep = since(card.stepSince, now);
  return (
    <p className="mt-1 text-[11px] text-muted-foreground" data-testid="staple-console-runtime">
      {running ? `Running ${running}` : active ? `Last activity ${active} ago` : "No run yet"}
      {" · in step "}
      {inStep ?? <Unknown />}
    </p>
  );
}

/** Containment is only checked for Staple's own repository, so it names that build (FAC-929). */
function installedText(value: boolean | null) {
  return value === true ? "in the installed Staple build" : value === false ? "not in the installed Staple build yet" : null;
}

function ProofPr({ pr }: { pr: StapleConsoleProofPullRequest | StapleConsoleCard["pullRequests"][number] }) {
  const installed = pr.state === "merged" ? installedText(pr.inInstalledBuild) : null;
  return (
    <li className="[overflow-wrap:anywhere]">
      <a href={pr.url} target="_blank" rel="noreferrer" className="underline">{pr.label}</a>
      <span className="text-muted-foreground">
        {" "}{stapleConsolePrStatusText(pr)}
        {pr.state === "merged" && pr.source === "github" ? ` · CI ${pr.ci === "unknown" || pr.ci === "none" ? "unknown" : pr.ci}` : ""}
        {pr.mergeCommitSha ? ` · ${pr.mergeCommitSha.slice(0, 8)}` : ""}
        {installed ? ` · ${installed}` : ""}
      </span>
    </li>
  );
}

function ConsoleCard({
  card,
  now,
  open,
  onToggle,
  anchor,
  highlighted,
  onJump,
}: {
  card: StapleConsoleCard;
  now: number;
  open: boolean;
  onToggle: () => void;
  /** Only the lane copy of a card carries the scroll anchor. */
  anchor: boolean;
  highlighted: boolean;
  onJump: (cardId: string) => void;
}) {
  const needsEthan = card.needsEthan.length > 0;
  const stuck = card.stuck.length > 0;
  const caption = cardCaption(card);
  return (
    <article
      id={anchor ? `console-card-${card.id}` : undefined}
      data-testid="staple-console-card"
      data-card-id={card.id}
      data-expanded={open ? "true" : "false"}
      className={cn(
        "scroll-mt-20 rounded-lg border bg-card p-3 transition-shadow",
        needsEthan ? CORAL : stuck ? "border-destructive bg-destructive/5" : "border-border",
        highlighted && "ring-2 ring-sky-500 ring-offset-2 ring-offset-background",
      )}
    >
      <Disclosure open={open} onToggle={onToggle} label={`${card.name}, ${open ? "collapse" : "expand"}`} className="items-start">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold leading-snug text-foreground [overflow-wrap:anywhere]">{card.name}</h3>
          <p className="text-[11px] text-muted-foreground">{cardSecondary(card)}</p>
        </div>
        {card.betaTag ? (
          <span className="ml-auto shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            {card.betaTag === "beta" ? "Beta" : card.betaTag === "beta_preview" ? "Beta preview" : "After beta"}
          </span>
        ) : null}
      </Disclosure>

      <div className="mt-2">
        <StepBar steps={card.steps} />
      </div>
      <p className="mt-1 text-xs text-foreground" data-testid="staple-console-caption">
        {caption.parts.join(" · ")} · {caption.owner ?? <Unknown />}
      </p>
      <RuntimeLine card={card} now={now} />

      {card.waitingOn.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-1 text-xs">
          <span className="text-muted-foreground">Waiting on</span>
          {card.waitingOn.map((chip) =>
            chip.cardId ? (
              <button
                key={chip.issueIdentifier}
                type="button"
                onClick={() => onJump(chip.cardId!)}
                title={chip.title}
                className="rounded-full border border-border px-2 py-0.5 hover:bg-accent"
              >
                {chip.issueIdentifier} · {chip.status.replace(/_/g, " ")}
              </button>
            ) : (
              <Link
                key={chip.issueIdentifier}
                to={`/issues/${chip.issueIdentifier}`}
                title={chip.title}
                className="rounded-full border border-dashed border-border px-2 py-0.5 hover:bg-accent"
              >
                {chip.issueIdentifier} · {chip.status.replace(/_/g, " ")}
              </Link>
            ),
          )}
        </div>
      ) : null}

      {open ? <CardDetail card={card} now={now} /> : null}
    </article>
  );
}

/** Level 4 proof for one card: shared by the lane card and the compact Shipped today row. */
function CardDetail({ card, now }: { card: StapleConsoleCard; now: number }) {
  const openTasks = card.members.filter((member) => member.status !== "done" && member.status !== "cancelled").length;
  return (
    <div className="mt-3 space-y-2 border-t border-border pt-2 text-xs" data-testid="staple-console-card-detail">
      {/* FAC-929: the workstream's own step, apart from each PR's state below it. */}
      <p data-testid="staple-console-workstream-state">
        <span className="font-medium text-foreground">Workstream </span>
        <span className="text-muted-foreground">
          at {STEP_LABELS[card.step]} · {openTasks === 0 ? "no tasks open" : `${openTasks} of ${card.members.length} tasks open`}
        </span>
      </p>
      {card.stuck.map((flag, index) => (
        <p key={`${flag.rule}-${flag.issueIdentifier}-${index}`} className="text-destructive" data-rule={flag.rule}>
          Stuck · {flag.issueIdentifier}: {flag.reason}
        </p>
      ))}
      {card.completionNote ? <p className="text-muted-foreground [overflow-wrap:anywhere]">{card.completionNote}</p> : null}
      <div>
        <h4 className="font-medium text-foreground">PR and CI <span className="font-normal text-muted-foreground">· each PR's own state</span></h4>
        {card.pullRequests.length > 0 ? (
          <ul className="mt-0.5 space-y-0.5">{card.pullRequests.map((pr) => <ProofPr key={pr.url} pr={pr} />)}</ul>
        ) : (
          <p className="text-muted-foreground">No PR linked</p>
        )}
      </div>
      <p>
        <span className="font-medium text-foreground">Review </span>
        {card.review ? (
          <span className="text-muted-foreground">
            {card.review.outcome === "approved" ? "approved" : "changes requested"} by {card.review.reviewerName ?? "unknown"}, {since(card.review.at, now) ?? "unknown"} ago
          </span>
        ) : (
          <span className="text-muted-foreground">none recorded</span>
        )}
      </p>
      <div>
        <h4 className="font-medium text-foreground">Tasks</h4>
        <ul className="mt-0.5 space-y-0.5">
          {card.members.map((member) => (
            <li key={member.identifier} className="flex gap-1">
              <Link to={`/issues/${member.identifier}`} className="shrink-0 underline">{member.identifier}</Link>
              <span className="min-w-0 truncate text-muted-foreground">
                {member.role} · {member.status.replace(/_/g, " ")}
                {member.assigneeName ? ` · ${member.assigneeName}` : ""}
              </span>
            </li>
          ))}
        </ul>
      </div>
      {card.lastComment ? (
        <div>
          <h4 className="font-medium text-foreground">
            Last comment <span className="font-normal text-muted-foreground">
              · {card.lastComment.issueIdentifier} · {card.lastComment.authorName ?? "unknown"} · {since(card.lastComment.at, now) ?? "unknown"} ago
            </span>
          </h4>
          <p className="mt-0.5 text-muted-foreground [overflow-wrap:anywhere]">{stapleConsolePlainText(card.lastComment.excerpt)}</p>
        </div>
      ) : null}
      <details className="text-[10px] text-muted-foreground">
        <summary className="cursor-pointer">Technical detail</summary>
        Lane from {card.laneSource}
      </details>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Level 1

function HeaderTiles({ header }: { header: StapleConsoleBoard["header"] }) {
  const items = [
    { label: "Merged today", value: header.mergedToday, tone: "" },
    { label: "In flight", value: header.inFlight, tone: "" },
    { label: "Needs you", value: header.needsEthan, tone: header.needsEthan ? CORAL : "" },
    { label: "Stuck", value: header.stuck, tone: header.stuck ? "border-destructive bg-destructive/5" : "" },
  ];
  return (
    <div className="grid grid-cols-2 gap-2" data-testid="staple-console-tiles">
      {items.map((item) => (
        <div key={item.label} className={cn("rounded-md border border-border p-2", item.tone)}>
          <div className="text-xl font-semibold tabular-nums text-foreground">{item.value}</div>
          <div className="text-[11px] leading-tight text-muted-foreground">{item.label}</div>
        </div>
      ))}
    </div>
  );
}

const ATTENTION_LABEL: Record<StapleConsoleAttentionItem["kind"], string> = {
  needs_you: "Needs you",
  stuck: "Stuck",
  unowned_merge: "Merge not owned",
};

const ATTENTION_TONE: Record<StapleConsoleAttentionItem["kind"], string> = {
  needs_you: CORAL,
  stuck: "border-destructive bg-destructive/5",
  unowned_merge: "border-amber-500 bg-amber-500/10",
};

/** Founder questions shown before "more"; stuck rows always all show (FAC-927). */
const NEEDS_YOU_VISIBLE = 5;

function AttentionLink({ item }: { item: StapleConsoleAttentionItem }) {
  return /^https?:/.test(item.href) ? (
    <a href={item.href} target="_blank" rel="noreferrer" className="shrink-0 font-medium underline">{item.linkLabel}</a>
  ) : (
    <Link to={item.href} className="shrink-0 font-medium underline">{item.linkLabel}</Link>
  );
}

/** One attention row: a one-line summary, with the full plain text one tap away. */
function AttentionRow({ item, onJump }: { item: StapleConsoleAttentionItem; onJump: (cardId: string) => void }) {
  const [open, setOpen] = useState(false);
  const summary = stapleConsoleSummaryLine(item.text);
  const full = stapleConsolePlainText(item.text);
  return (
    <li data-kind={item.kind} data-testid="staple-console-attention-item" className={cn("rounded-md border px-2 py-1.5 text-xs", ATTENTION_TONE[item.kind])}>
      <div className="flex items-baseline gap-1.5">
        <span className={cn("shrink-0 whitespace-nowrap font-semibold", item.kind === "stuck" ? "text-destructive" : "text-foreground")}>
          {ATTENTION_LABEL[item.kind]}
        </span>
        <button type="button" onClick={() => onJump(item.cardId)} className="min-w-0 flex-1 truncate text-left font-medium text-foreground underline">
          {item.name}
        </button>
        <span className="shrink-0 text-[11px] text-muted-foreground">{item.identifier}</span>
        <AttentionLink item={item} />
      </div>
      <p className="mt-0.5 line-clamp-2 text-foreground [overflow-wrap:anywhere]" data-testid="staple-console-attention-summary">{summary}</p>
      {full !== summary ? (
        <>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            className="text-[11px] text-muted-foreground underline"
            data-testid="staple-console-attention-more"
          >
            {open ? "Less" : "Full text"}
          </button>
          {open ? <p className="mt-0.5 text-muted-foreground [overflow-wrap:anywhere]">{full}</p> : null}
        </>
      ) : null}
    </li>
  );
}

function AttentionList({
  items,
  onJump,
  isOpen,
  toggle,
}: {
  items: StapleConsoleAttentionItem[];
  onJump: (cardId: string) => void;
  isOpen: (key: string) => boolean;
  toggle: (key: string) => void;
}) {
  if (items.length === 0) {
    return (
      <p
        className="flex items-center gap-2 rounded-md border border-emerald-500/50 bg-emerald-500/10 p-2 text-sm text-foreground"
        data-testid="staple-console-all-clear"
      >
        <Dot state="green" /> Nothing needs you; nothing stalled.
      </p>
    );
  }
  const stuck = items.filter((item) => item.kind === "stuck");
  const questions = items.filter((item) => item.kind === "needs_you");
  const merges = items.filter((item) => item.kind === "unowned_merge");
  const moreQuestions = isOpen("attention:questions");
  const shownQuestions = moreQuestions ? questions : questions.slice(0, NEEDS_YOU_VISIBLE);
  const mergesOpen = isOpen("attention:merges");
  // Every category is counted on the first screen, even the parts behind a tap.
  const summary = [
    stuck.length > 0 ? `${stuck.length} stuck` : null,
    questions.length > 0 ? `${questions.length} ${questions.length === 1 ? "question" : "questions"} for you` : null,
    merges.length > 0 ? `${merges.length} ${merges.length === 1 ? "merge" : "merges"} nobody owns` : null,
  ].filter(Boolean).join(" · ");
  return (
    <section aria-label="Needs attention" className="space-y-1.5" data-testid="staple-console-attention">
      <h2 className="text-sm font-semibold text-foreground">
        Needs attention <span className="font-normal text-muted-foreground" data-testid="staple-console-attention-summary-line">· {summary}</span>
      </h2>
      <ul className="space-y-1.5">
        {[...stuck, ...shownQuestions].map((item, index) => (
          <AttentionRow key={`${item.kind}-${item.identifier}-${index}`} item={item} onJump={onJump} />
        ))}
      </ul>
      {questions.length > NEEDS_YOU_VISIBLE ? (
        <button
          type="button"
          aria-expanded={moreQuestions}
          onClick={() => toggle("attention:questions")}
          className="text-xs text-muted-foreground underline"
          data-testid="staple-console-attention-more-questions"
        >
          {moreQuestions ? "Show fewer questions" : `Show ${questions.length - NEEDS_YOU_VISIBLE} more ${questions.length - NEEDS_YOU_VISIBLE === 1 ? "question" : "questions"}`}
        </button>
      ) : null}
      {merges.length > 0 ? (
        <div className={cn("rounded-md border px-2 py-1.5 text-xs", ATTENTION_TONE.unowned_merge)} data-testid="staple-console-attention-merges">
          <Disclosure
            open={mergesOpen}
            onToggle={() => toggle("attention:merges")}
            label={`Merges nobody owns, ${merges.length}, ${mergesOpen ? "collapse" : "expand"}`}
            className="items-baseline"
          >
            <span className="shrink-0 whitespace-nowrap font-semibold text-foreground">{ATTENTION_LABEL.unowned_merge}</span>
            <span className="min-w-0 truncate text-foreground">
              {merges.length} done, merge not confirmed
            </span>
          </Disclosure>
          {mergesOpen ? (
            <ul className="mt-1 space-y-1 border-t border-amber-500/40 pt-1">
              {merges.map((item, index) => (
                <li key={`${item.identifier}-${index}`} data-kind={item.kind} className="flex items-baseline gap-1.5">
                  <button type="button" onClick={() => onJump(item.cardId)} className="min-w-0 flex-1 text-left">
                    <span className="block truncate font-medium text-foreground underline">{item.name}</span>
                    <span className="block text-[11px] text-muted-foreground [overflow-wrap:anywhere]">{item.identifier} · {stapleConsolePlainText(item.text)}</span>
                  </button>
                  <AttentionLink item={item} />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Level 2

function Counts({ counts }: { counts: StapleConsoleCapability["counts"] }) {
  return (
    <span className="flex shrink-0 items-center gap-2 text-xs tabular-nums text-foreground" aria-label={`${counts.green} works now, ${counts.blue} being built, ${counts.red} needs attention`}>
      {(["green", "blue", "red"] as const).map((state) => (
        <span key={state} className={cn("flex items-center gap-1", counts[state] === 0 && "opacity-40")}>
          <Dot state={state} />
          {counts[state]}
        </span>
      ))}
    </span>
  );
}

/** A Staple PR is the only kind the installed build can contain; others name their repo. */
function isStaplePr(pr: StapleConsoleProofPullRequest) {
  return pr.inInstalledBuild !== null || pr.label.startsWith("paperclip#");
}

function ClaimProof({
  claim,
  installedBuild,
  staple,
  now,
}: {
  claim: StapleConsoleClaim;
  installedBuild: string | null;
  /** Claims in the Staple group: the Console's host build is their installed build. */
  staple: boolean;
  now: number;
}) {
  const { pullRequests, acceptance } = claim.proof;
  // One line per task, reviewer and verdict, with the latest time and how many verdicts it covers.
  const reviews = [...claim.proof.reviews]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .reduce<Array<StapleConsoleClaim["proof"]["reviews"][number] & { count: number }>>((rows, review) => {
      const same = rows.find((row) => row.issueIdentifier === review.issueIdentifier && row.outcome === review.outcome && row.reviewerName === review.reviewerName);
      if (same) same.count += 1;
      else rows.push({ ...review, count: 1 });
      return rows;
    }, []);
  const showsStapleBuild = staple || pullRequests.some(isStaplePr);
  return (
    <div className="space-y-1 rounded-md bg-muted/50 p-2 text-[11px]" data-testid="staple-console-proof">
      <h5 className="font-medium text-foreground">Proof</h5>
      {pullRequests.length > 0 ? (
        <ul className="space-y-0.5">{pullRequests.map((pr) => <ProofPr key={pr.url} pr={pr} />)}</ul>
      ) : (
        <p className="text-muted-foreground">No PR linked</p>
      )}
      {reviews.map((review) => (
        <p key={`${review.issueIdentifier}-${review.at}`} className="text-muted-foreground">
          Review {review.outcome === "approved" ? "approved" : "changes requested"} by {review.reviewerName ?? "unknown"} on {review.issueIdentifier}, {since(review.at, now) ?? "unknown"} ago
          {review.count > 1 ? ` (${review.count} verdicts)` : ""}
        </p>
      ))}
      {claim.needsAcceptance || acceptance ? (
        <p className="text-muted-foreground">
          Acceptance:{" "}
          {acceptance && (acceptance.evidence.length > 0 || acceptance.at) ? (
            <>
              {acceptance.at ? `passed ${clock(acceptance.at)}` : "recorded"}
              {acceptance.evidence.map((link, index) => (
                <a key={link} href={link} target="_blank" rel="noreferrer" className="ml-1 underline">evidence {index + 1}</a>
              ))}
              {acceptance.note ? ` · ${acceptance.note}` : ""}
            </>
          ) : (
            "not recorded"
          )}
        </p>
      ) : null}
      {showsStapleBuild ? (
        <p className="text-muted-foreground">Installed Staple build: {installedBuild ?? <Unknown />}</p>
      ) : (
        <p className="text-muted-foreground">Deployed build: not tracked here (the Console reports Staple's build only)</p>
      )}
    </div>
  );
}

function ClaimRow({
  claim,
  open,
  onToggle,
  renderCard,
  installedBuild,
  staple,
  now,
}: {
  claim: StapleConsoleClaim;
  open: boolean;
  onToggle: () => void;
  renderCard: (cardId: string) => ReactNode;
  installedBuild: string | null;
  staple: boolean;
  now: number;
}) {
  return (
    <li data-testid="staple-console-claim" data-state={claim.state} className="py-1.5">
      <Disclosure open={open} onToggle={onToggle} label={`${claim.text}, ${open ? "collapse" : "expand"}`} className="items-start">
        <Dot state={claim.state} className="mt-1" />
        <span className="min-w-0">
          <span className="block text-xs font-medium text-foreground [overflow-wrap:anywhere]">{claim.text}</span>
          {claim.why ? (
            <span className="block text-[11px] text-muted-foreground [overflow-wrap:anywhere]">Why: {claim.why}</span>
          ) : null}
        </span>
      </Disclosure>
      {open ? (
        <div className="ml-4 mt-1 space-y-2">
          <p className="text-[11px] text-muted-foreground [overflow-wrap:anywhere]">{claim.stateReason}</p>
          {claim.cardIds.map((cardId) => <div key={cardId}>{renderCard(cardId)}</div>)}
          {claim.cardIds.length === 0 && claim.tasks.length > 0 ? (
            <ul className="text-[11px] text-muted-foreground">
              {claim.tasks.map((task) => (
                <li key={task.identifier}>
                  <Link to={`/issues/${task.identifier}`} className="underline">{task.identifier}</Link>
                  {" "}{task.name} · {task.status.replace(/_/g, " ")}
                </li>
              ))}
            </ul>
          ) : null}
          <ClaimProof claim={claim} installedBuild={installedBuild} staple={staple} now={now} />
        </div>
      ) : null}
    </li>
  );
}

function Capabilities({
  board,
  isOpen,
  toggle,
  renderCard,
  now,
}: {
  board: StapleConsoleBoard;
  isOpen: (key: string) => boolean;
  toggle: (key: string) => void;
  renderCard: (cardId: string) => ReactNode;
  now: number;
}) {
  const capabilities = board.capabilities;
  return (
    <section aria-label="Capabilities" className="space-y-2" data-testid="staple-console-capabilities">
      <h2 className="text-sm font-semibold text-foreground">What works now</h2>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground" data-testid="staple-console-legend">
        <span className="flex items-center gap-1"><Dot state="green" /> Works now, with proof</span>
        <span className="flex items-center gap-1"><Dot state="blue" /> Being fixed or built</span>
        <span className="flex items-center gap-1"><Dot state="red" /> Needs attention, nothing fixing it</span>
      </p>
      {!capabilities?.source.available ? (
        <p className="text-xs text-muted-foreground">
          Capability map <Unknown />
          {capabilities?.source.detail ? <span className="block text-[11px]">{capabilities.source.detail}</span> : null}
        </p>
      ) : (
        capabilities.groups.map((group) => (
          <div key={group.key} className="rounded-md border border-border">
            <h3 className="border-b border-border px-2 py-1.5 text-xs font-semibold text-foreground">{group.label}</h3>
            <ul className="divide-y divide-border">
              {group.capabilities.map((capability) => {
                const key = `cap:${group.key}/${capability.key}`;
                const open = isOpen(key);
                return (
                  <li key={capability.key} data-testid="staple-console-capability" className="px-2 py-1.5">
                    <Disclosure open={open} onToggle={() => toggle(key)} label={`${capability.title}, ${open ? "collapse" : "expand"}`}>
                      <span className="min-w-0 truncate text-sm text-foreground">{capability.title}</span>
                      <span className="ml-auto"><Counts counts={capability.counts} /></span>
                    </Disclosure>
                    {open ? (
                      <ul className="mt-1 divide-y divide-border/50">
                        {capability.claims.map((claim) => (
                          <ClaimRow
                            key={claim.id}
                            claim={claim}
                            open={isOpen(`claim:${claim.id}`)}
                            onToggle={() => toggle(`claim:${claim.id}`)}
                            renderCard={renderCard}
                            installedBuild={capabilities.installedBuild}
                            staple={group.key === "staple"}
                            now={now}
                          />
                        ))}
                      </ul>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Page

function MaintenanceHoldBanner({ hold }: { hold: NonNullable<StapleConsoleBoard["maintenanceHold"]> }) {
  return (
    <div
      role="status"
      className="rounded-md border border-amber-500 bg-amber-500/10 p-2 text-xs text-foreground"
      data-testid="staple-console-maintenance-hold"
    >
      <p className="font-semibold">
        Maintenance hold since {clock(hold.since) ?? "unknown"}, {hold.queuedWakes} {hold.queuedWakes === 1 ? "wake" : "wakes"} queued
      </p>
      <p className="text-muted-foreground">
        New runs are held, not dropped.{" "}
        {hold.parkedRuns > 0
          ? `${hold.parkedRuns} parked at the drain deadline. `
          : hold.runningRuns > 0
            ? `${hold.runningRuns} still finishing until ${clock(hold.drainDeadlineAt) ?? "unknown"}. `
            : ""}
        Lifts after the upgrade, or by {clock(hold.expiresAt) ?? "unknown"} at the latest.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Managed upgrade (FAC-620 upgrade status)

const UPGRADE_PILL: Record<StapleConsoleUpgradePhase, { label: string; tone: string }> = {
  running: { label: "Upgrading", tone: "bg-sky-500 text-white" },
  waiting: { label: "Waiting", tone: "bg-muted text-foreground" },
  up_to_date: { label: "Up to date", tone: "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300" },
  verified: { label: "Verified", tone: "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300" },
  skipped: { label: "Didn't install", tone: "bg-amber-500/20 text-amber-800 dark:text-amber-300" },
  failed: { label: "Failed", tone: "bg-red-500 text-white" },
  rolled_back: { label: "Rolled back", tone: "bg-red-500 text-white" },
  needs_ethan: { label: "Needs you", tone: "bg-[#f0714f] text-white" },
  stale: { label: "Not reporting", tone: "bg-amber-500/20 text-amber-800 dark:text-amber-300" },
  unknown: { label: "Unknown", tone: "bg-muted text-muted-foreground" },
};

const UPGRADE_BORDER: Partial<Record<StapleConsoleUpgradePhase, string>> = {
  running: "border-sky-500",
  failed: "border-red-500",
  rolled_back: "border-red-500",
  needs_ethan: CORAL,
  stale: "border-amber-500",
};

/** An idle card stays one line once its last install is this old. */
const UPGRADE_RECENT_MS = 6 * 60 * 60_000;
/** These stages restart Staple, so a lost connection is expected. */
const RESTARTING_STAGES = new Set(["download_build", "restart", "verify", "rollback"]);

function UpgradeStageStrip({ stages }: { stages: StapleConsoleUpgradeStageCell[] }) {
  return (
    <ol className="grid grid-cols-6 gap-1" aria-label="Upgrade stage">
      {stages.map((cell) => (
        <li
          key={cell.key}
          aria-current={cell.state === "current" ? "step" : undefined}
          data-state={cell.state}
          className={cn(
            "min-w-0 truncate rounded px-0.5 py-0.5 text-center text-[10px] leading-tight",
            cell.state === "done" && "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300",
            cell.state === "current" && "bg-sky-500 font-semibold text-white",
            cell.state === "failed" && "bg-red-500 font-semibold text-white",
            cell.state === "pending" && "bg-muted text-muted-foreground",
            cell.state === "skipped" && "border border-dashed border-muted-foreground/40 text-muted-foreground",
          )}
          title={cell.label}
        >
          {STAPLE_UPGRADE_STAGE_SHORT[cell.key]}
        </li>
      ))}
    </ol>
  );
}

function UpgradeCard({
  upgrade,
  now,
  open,
  onToggle,
  connection,
}: {
  upgrade: StapleConsoleUpgradeStatus;
  now: number;
  open: boolean;
  onToggle: () => void;
  connection?: { lost: boolean; lastLoadedAt: number | null };
}) {
  const pill = UPGRADE_PILL[upgrade.phase];
  const lost = Boolean(connection?.lost);
  const recentInstall = upgrade.attemptEndedAt !== null && now - Date.parse(upgrade.attemptEndedAt) < UPGRADE_RECENT_MS;
  const compact = !lost && !upgrade.hold && !open && (
    upgrade.phase === "up_to_date"
    || upgrade.phase === "waiting"
    || upgrade.phase === "unknown"
    || (upgrade.phase === "verified" && !recentInstall)
  );
  const stageLabel = upgrade.stage ? STAPLE_UPGRADE_STAGE_LABELS[upgrade.stage] : null;
  const stageFor = since(upgrade.stageStartedAt, now);
  const total = upgrade.attemptEndedAt
    ? upgrade.attemptStartedAt ? formatStapleConsoleDuration(Date.parse(upgrade.attemptEndedAt) - Date.parse(upgrade.attemptStartedAt)) : null
    : since(upgrade.attemptStartedAt, now);
  const lastOutput = since(upgrade.lastOutputAt, now);
  const drain = upgrade.stage === "draining" ? stapleUpgradeDrainText(upgrade.drainRunning) : null;
  const lostAt = connection?.lastLoadedAt ? clock(new Date(connection.lastLoadedAt).toISOString()) : null;
  const restartExpected = lost && upgrade.phase === "running" && upgrade.stage !== null && RESTARTING_STAGES.has(upgrade.stage);

  if (compact) {
    return (
      <section aria-label="Upgrades" className="rounded-md border border-border px-2 py-1.5 text-xs" data-testid="staple-console-upgrade" data-phase={upgrade.phase} data-compact="true">
        <Disclosure open={false} onToggle={onToggle} label="Upgrades, expand" testId="staple-console-upgrade-toggle" className="items-baseline">
          <span className="font-semibold text-foreground">Upgrades</span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {upgrade.phase === "unknown" ? <Unknown /> : upgrade.headline}
            {upgrade.installed && upgrade.phase !== "waiting" ? ` · on ${upgrade.installed}` : ""}
          </span>
        </Disclosure>
      </section>
    );
  }

  return (
    <section
      aria-label="Upgrades"
      className={cn("space-y-1.5 rounded-md border p-2 text-xs", UPGRADE_BORDER[upgrade.phase] ?? "border-border", lost && "border-dashed")}
      data-testid="staple-console-upgrade"
      data-phase={upgrade.phase}
      data-compact="false"
    >
      <Disclosure open={open} onToggle={onToggle} label={`Upgrades, ${open ? "collapse" : "expand"}`} testId="staple-console-upgrade-toggle" className="items-center">
        <span className="font-semibold text-foreground">Upgrades</span>
        <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold", pill.tone)}>{pill.label}</span>
        {upgrade.quiet ? <span className="text-[10px] text-muted-foreground">daytime</span> : null}
      </Disclosure>
      <p className="font-medium text-foreground" data-testid="staple-console-upgrade-headline">{upgrade.headline}</p>

      {lost ? (
        <p role="status" className="rounded border border-amber-500 bg-amber-500/10 px-1.5 py-1 text-[11px] text-foreground" data-testid="staple-console-upgrade-lost">
          {restartExpected
            ? `Can't reach Staple since ${lostAt ?? "the last refresh"}. Expected while it restarts: showing the last known stage.`
            : `Can't reach Staple since ${lostAt ?? "the last refresh"}. Upgrade state is the last known.`}
        </p>
      ) : null}

      {upgrade.stages.length > 0 ? <UpgradeStageStrip stages={upgrade.stages} /> : null}

      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px]" data-testid="staple-console-upgrade-facts">
        {upgrade.phase === "running" || upgrade.phase === "stale" ? (
          <>
            <dt className="text-muted-foreground">Stage</dt>
            <dd className="text-foreground">{stageLabel ?? <Unknown />}{stageFor ? ` · ${stageFor}` : ""}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">{upgrade.attemptEndedAt ? "Took" : "Elapsed"}</dt>
        <dd className="text-foreground">{total ?? <Unknown />}</dd>
        <dt className="text-muted-foreground">Last output</dt>
        <dd className={cn("text-foreground", upgrade.phase === "stale" && "font-semibold")}>{lastOutput ? `${lastOutput} ago` : <Unknown />}</dd>
        {upgrade.download ? (
          <>
            <dt className="text-muted-foreground">Download</dt>
            <dd className="text-foreground" data-testid="staple-console-upgrade-download">
              {upgrade.download.bytes !== null && upgrade.download.totalBytes
                ? `${Math.floor((upgrade.download.bytes / upgrade.download.totalBytes) * 100)}%`
                : <><span className="text-muted-foreground">size unknown</span> · no ETA</>}
            </dd>
          </>
        ) : null}
        {drain ? (
          <>
            <dt className="text-muted-foreground">Drain</dt>
            <dd className="text-foreground">{drain}</dd>
          </>
        ) : null}
        {upgrade.hold ? (
          <>
            <dt className="text-muted-foreground">Held</dt>
            <dd className="text-foreground" data-testid="staple-console-upgrade-hold">
              {upgrade.hold.queuedWakes} queued{upgrade.hold.parkedRuns > 0 ? ` · ${upgrade.hold.parkedRuns} parked` : ""} · lifts by {clock(upgrade.hold.expiresAt) ?? "unknown"}
            </dd>
          </>
        ) : null}
        {/* A founder action replaces "next": nothing automatic follows it. */}
        {upgrade.needsEthan ? null : (
          <>
            <dt className="text-muted-foreground">Next</dt>
            <dd className="text-foreground" data-testid="staple-console-upgrade-next">{upgrade.nextAction ?? <Unknown />}</dd>
          </>
        )}
      </dl>

      {upgrade.needsEthan ? (
        <p className={cn("rounded border p-1.5 text-[11px] text-foreground", CORAL)} data-testid="staple-console-upgrade-needs-ethan">
          <span className="font-semibold">Needs you: </span>{upgrade.needsEthan}
        </p>
      ) : null}

      {open ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 border-t border-border pt-1.5 text-[11px]" data-testid="staple-console-upgrade-detail">
          <dt className="text-muted-foreground">Installed</dt>
          <dd className="font-mono text-foreground">{upgrade.installed ?? <Unknown />}</dd>
          <dt className="text-muted-foreground">Target</dt>
          <dd className="font-mono text-foreground">{upgrade.target ?? <Unknown />}</dd>
          <dt className="text-muted-foreground">Master</dt>
          <dd className="font-mono text-foreground">{upgrade.master ?? <Unknown />}</dd>
          <dt className="text-muted-foreground">Started</dt>
          <dd className="text-foreground">{clock(upgrade.attemptStartedAt) ?? <Unknown />}</dd>
          {upgrade.outcome ? (
            <>
              <dt className="text-muted-foreground">Result</dt>
              <dd className="text-foreground">{upgrade.outcome}</dd>
            </>
          ) : null}
          {upgrade.lastInstall ? (
            <>
              <dt className="text-muted-foreground">Last install</dt>
              <dd className="text-foreground">
                {UPGRADE_PILL[upgrade.lastInstall.phase].label} {upgrade.lastInstall.from ?? "unknown"} → {upgrade.lastInstall.to ?? "unknown"}, {clock(upgrade.lastInstall.at)}
              </dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Source</dt>
          <dd className="text-muted-foreground">{upgrade.source.detail}{upgrade.source.logName ? ` · ${upgrade.source.logName}` : ""}</dd>
        </dl>
      ) : null}
    </section>
  );
}

/** ISO times inside a source's detail line, as "N ago" or "in N" (FAC-930 freshness). */
function relativeTimes(text: string, now: number) {
  return text.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z\b/g, (iso) => {
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) return iso;
    return at <= now ? `${formatStapleConsoleDuration(now - at)} ago` : `in ${formatStapleConsoleDuration(at - now)}`;
  });
}

/**
 * Scheduled entries (FAC-930). Only Paperclip's own records (monitors, routines, watcher log)
 * are verified times; a planned job Paperclip does not record shows as planned and unverified,
 * with its source, never as a definite time.
 */
function ScheduleGroup({
  title,
  events,
  now,
  testId,
}: {
  title: string;
  events: StapleConsoleBoard["scheduled"];
  now: number;
  testId: string;
}) {
  return (
    <div className="space-y-1" data-testid={testId}>
      <h3 className="text-[11px] font-medium text-muted-foreground">{title}</h3>
      <div className="grid grid-cols-2 gap-2">
        {events.map((event, index) => (
          <div
            key={`${event.label}-${index}`}
            className={cn("rounded-md border p-2 text-[11px]", event.available ? "border-border" : "border-dashed border-border")}
            data-testid="staple-console-schedule-event"
            data-available={event.available ? "true" : "false"}
          >
            <div className="font-medium text-foreground">{event.label}</div>
            <div className="text-muted-foreground">
              {event.available
                ? event.at ? clock(event.at) : "not scheduled"
                : event.at ? `Planned ${clock(event.at)} · not verified` : <Unknown />}
            </div>
            {event.available && event.detail ? (
              <div className="line-clamp-2 text-[10px] text-muted-foreground [overflow-wrap:anywhere]">{relativeTimes(event.detail, now)}</div>
            ) : null}
            <div className="line-clamp-2 text-[10px] text-muted-foreground [overflow-wrap:anywhere]">Source: {event.source}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function StapleConsoleBoardView({
  board,
  now,
  connection,
}: {
  board: StapleConsoleBoard;
  now: number;
  /** A failed refresh while a board is loaded: during an install restart this is expected. */
  connection?: { lost: boolean; lastLoadedAt: number | null };
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const isOpen = useCallback((key: string) => expanded.has(key), [expanded]);
  const toggle = useCallback((key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const jump = useCallback((cardId: string) => {
    setHighlighted(cardId);
    setExpanded((current) => new Set(current).add(`card:${cardId}`));
    window.requestAnimationFrame?.(() => {
      document.getElementById(`console-card-${cardId}`)?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    });
  }, []);

  useEffect(() => {
    if (!highlighted) return;
    const timer = window.setTimeout(() => setHighlighted(null), 4000);
    return () => window.clearTimeout(timer);
  }, [highlighted]);

  const cards = board.lanes.flatMap((lane) => lane.cards);
  const cardById = new Map(cards.map((card) => [card.id, card]));
  const card = (target: StapleConsoleCard, anchor: boolean) => (
    <ConsoleCard
      key={target.id}
      card={target}
      now={now}
      open={isOpen(`card:${target.id}`)}
      onToggle={() => toggle(`card:${target.id}`)}
      anchor={anchor}
      highlighted={anchor && highlighted === target.id}
      onJump={jump}
    />
  );
  const attention = board.attention ?? [];
  // FAC-928: tiles count the rows this page lists, so a tile and its list always agree.
  const header = stapleConsoleHeaderCounts(cards, attention);
  const shipped = cards.filter((target) => target.shipped)
    .sort((a, b) => Number(b.mergedToday) - Number(a.mergedToday));
  const mergedEarlier = shipped.filter((target) => target.completion === "merged" && !target.mergedToday).length;
  const notMerged = shipped.filter((target) => target.completion !== "merged").length;
  const finishedBreakdown = [
    `${header.mergedToday} merged today`,
    mergedEarlier > 0 ? `${mergedEarlier} merged before today` : null,
    notMerged > 0 ? `${notMerged} finished without a merge` : null,
  ].filter(Boolean).join(" · ");
  const upNextOpen = isOpen("upnext");
  const recordedSchedule = board.scheduled.filter((event) => event.available);
  const plannedSchedule = board.scheduled.filter((event) => !event.available);

  return (
    <div className="space-y-5">
      {/* The upgrade card carries the hold; the banner remains for a server without it. */}
      {board.maintenanceHold && !board.upgrade ? <MaintenanceHoldBanner hold={board.maintenanceHold} /> : null}

      {/* Level 1: is anything stalled or waiting on me? */}
      <HeaderTiles header={header} />
      {board.upgrade ? (
        <UpgradeCard
          upgrade={board.upgrade}
          now={now}
          open={isOpen("upgrade")}
          onToggle={() => toggle("upgrade")}
          connection={connection}
        />
      ) : null}
      <AttentionList items={attention} onJump={jump} isOpen={isOpen} toggle={toggle} />

      {/* Level 2: what can the system do now? */}
      <Capabilities
        board={board}
        isOpen={isOpen}
        toggle={toggle}
        renderCard={(cardId) => {
          const target = cardById.get(cardId);
          return target ? card(target, false) : null;
        }}
        now={now}
      />

      {/* Level 3: what is going on, by Free beta lane. */}
      <section aria-label="Active work" className="space-y-3" data-testid="staple-console-active">
        <h2 className="text-sm font-semibold text-foreground">Active work</h2>
        {!board.sources.github.available ? (
          <p className="text-[11px] text-muted-foreground">PR state from Paperclip records, not live GitHub</p>
        ) : null}
        {board.lanes.map((lane) => {
          const active = lane.cards.filter((target) => !target.shipped);
          if (active.length === 0) {
            return (
              <p key={lane.key} className="text-xs text-muted-foreground" data-testid="staple-console-lane-empty" data-lane={lane.key}>
                {lane.label} · nothing active
              </p>
            );
          }
          return (
            <section key={lane.key} aria-label={lane.label} className="space-y-2" data-testid="staple-console-lane" data-lane={lane.key}>
              <h3 className="text-xs font-semibold text-foreground">
                {lane.label} <span className="font-normal text-muted-foreground">· {active.length}</span>
              </h3>
              {active.map((target) => card(target, true))}
            </section>
          );
        })}
      </section>

      {shipped.length > 0 ? (
        <section aria-label="Finished today" className="space-y-1" data-testid="staple-console-shipped">
          <h2 className="text-sm font-semibold text-foreground">
            Finished today <span className="font-normal text-muted-foreground">· {shipped.length}</span>
          </h2>
          {/* FAC-928: tasks finished today and PRs merged today are different counts; say how. */}
          <p className="text-[11px] text-muted-foreground" data-testid="staple-console-finished-breakdown">{finishedBreakdown}</p>
          <ul className="divide-y divide-border rounded-md border border-border text-xs">
            {shipped.map((target) => {
              const merged = target.pullRequests.find((pr) => pr.state === "merged");
              const open = isOpen(`card:${target.id}`);
              return (
                <li
                  key={target.id}
                  id={`console-card-${target.id}`}
                  data-testid="staple-console-shipped-row"
                  data-card-id={target.id}
                  data-expanded={open ? "true" : "false"}
                  className={cn("scroll-mt-20 px-2 py-1.5", highlighted === target.id && "ring-2 ring-sky-500")}
                >
                  <div className="flex items-baseline gap-2">
                    <Disclosure
                      open={open}
                      onToggle={() => toggle(`card:${target.id}`)}
                      label={`${target.name}, ${target.mergedToday ? "merged today" : target.completion === "merged" ? "merged before today" : "finished without a merge"}, ${open ? "collapse" : "expand"}`}
                      className="min-w-0 flex-1 items-baseline"
                    >
                      <Dot state={target.completion === "merged" ? "green" : "blue"} />
                      <span className="min-w-0 flex-1 truncate text-foreground">{target.name}</span>
                    </Disclosure>
                    {merged ? (
                      <a href={merged.url} target="_blank" rel="noreferrer" className="shrink-0 text-muted-foreground underline">
                        {target.identifier} · #{merged.label.split("#").pop()}
                      </a>
                    ) : (
                      <Link to={`/issues/${target.identifier}`} className="shrink-0 text-muted-foreground underline">{target.identifier}</Link>
                    )}
                  </div>
                  {open ? <CardDetail card={target} now={now} /> : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {board.upNext.length > 0 ? (
        <section aria-label="Up next, not queued" className="space-y-1">
          <Disclosure
            open={upNextOpen}
            onToggle={() => toggle("upnext")}
            label={`Up next, not queued, ${board.upNext.length}, ${upNextOpen ? "collapse" : "expand"}`}
            testId="staple-console-upnext-toggle"
          >
            <h2 className="text-sm font-semibold text-foreground">
              Up next, not queued <span className="font-normal text-muted-foreground">· {board.upNext.length}</span>
            </h2>
          </Disclosure>
          {upNextOpen ? (
            <ul className="space-y-1 text-xs" data-testid="staple-console-upnext">
              {board.upNext.map((gap) => (
                <li key={gap.fac} className={cn("rounded-md border p-2", gap.betaGap ? CORAL : "border-border")}>
                  <span className="text-foreground">{gap.title}</span>
                  <span className="text-muted-foreground">
                    {" "}·{" "}
                    <a href={`https://linear.app/facette/issue/FAC-${gap.fac}`} target="_blank" rel="noreferrer" className="underline">
                      FAC-{gap.fac}
                    </a>
                    {" "}· {gap.tag === "beta" ? "Beta, no Staple task" : gap.tag ? gap.tag.replace(/_/g, " ") : "tag not set"}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      <section aria-label="Scheduled and waiting" className="space-y-1" data-testid="staple-console-scheduled">
        <h2 className="text-sm font-semibold text-foreground">Scheduled and waiting</h2>
        {recordedSchedule.length > 0 ? (
          <ScheduleGroup title="Recorded in Paperclip" events={recordedSchedule} now={now} testId="staple-console-schedule-recorded" />
        ) : null}
        {plannedSchedule.length > 0 ? (
          <ScheduleGroup title="Planned, not verified here" events={plannedSchedule} now={now} testId="staple-console-schedule-planned" />
        ) : null}
      </section>

      <p className="text-[10px] text-muted-foreground">
        Read-only. Built {clock(board.generatedAt) ?? "unknown"} from Paperclip tasks, runs, interactions, approvals and
        work products. GitHub: {board.sources.github.detail}
        {board.capabilities?.source.available ? ` Capabilities from ${board.capabilities.source.detail}.` : ""}
      </p>
    </div>
  );
}

export function StapleConsole() {
  const { selectedCompanyId, companies } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const visible = useDocumentVisible();
  const now = useNow(visible);

  useEffect(() => {
    setBreadcrumbs([{ label: "Staple Console" }]);
  }, [setBreadcrumbs]);

  const query = useQuery({
    queryKey: ["staple-console", selectedCompanyId],
    queryFn: () => stapleConsoleApi.board(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: STAPLE_CONSOLE_POLL_MS,
    // Polling pauses while the tab is hidden and refreshes on return.
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });

  if (!selectedCompanyId) {
    return (
      <EmptyState
        icon={LayoutDashboard}
        message={companies.length === 0 ? "Create an organization to view the console." : "Select an organization to view the console."}
      />
    );
  }

  const board = query.data;
  const freshness = stapleConsoleFreshness(query.dataUpdatedAt || null, now);
  const stale = freshness.stale;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 pb-10" data-testid="staple-console">
      <div className="flex items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold text-foreground">Staple Console</h1>
        <span
          className={cn("text-xs tabular-nums", stale ? "font-semibold text-muted-foreground" : "text-muted-foreground")}
          data-testid="staple-console-freshness"
          data-stale={stale ? "true" : "false"}
        >
          {stale && board ? "Stale · " : ""}
          {freshness.label}
          {!visible ? " · paused" : ""}
        </span>
      </div>

      {query.error ? (
        <p className="rounded-md border border-destructive bg-destructive/5 p-2 text-xs text-destructive">
          Could not refresh: {query.error instanceof Error ? query.error.message : "request failed"}.
          {board ? " Showing the last loaded board." : ""}
        </p>
      ) : null}

      {!board ? (
        <p className="text-sm text-muted-foreground">{query.isLoading ? "Loading the board…" : "No board loaded."}</p>
      ) : (
        <div className={cn("transition", stale && "opacity-60 grayscale")} data-stale={stale ? "true" : "false"}>
          <StapleConsoleBoardView
            board={board}
            now={now}
            connection={{ lost: Boolean(query.error), lastLoadedAt: query.dataUpdatedAt || null }}
          />
        </div>
      )}
    </div>
  );
}
