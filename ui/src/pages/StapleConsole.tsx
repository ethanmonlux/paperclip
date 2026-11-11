import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, LayoutDashboard } from "lucide-react";
import {
  STAPLE_CONSOLE_POLL_MS,
  formatStapleConsoleDuration,
  stapleConsoleFreshness,
  stapleConsolePrStatusText,
  type StapleConsoleAttentionItem,
  type StapleConsoleBoard,
  type StapleConsoleCapability,
  type StapleConsoleCard,
  type StapleConsoleCardStep,
  type StapleConsoleClaim,
  type StapleConsoleClaimState,
  type StapleConsoleProofPullRequest,
  type StapleConsoleStepCell,
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

const CORAL = "border-destructive bg-destructive/10";

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
            "min-w-0 truncate rounded px-1 py-0.5 text-center text-(length:--text-nano) leading-tight",
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
    <p className="mt-1 text-xs text-muted-foreground" data-testid="staple-console-runtime">
      {running ? `Running ${running}` : active ? `Last activity ${active} ago` : "No run yet"}
      {" · in step "}
      {inStep ?? <Unknown />}
    </p>
  );
}

function installedText(value: boolean | null) {
  return value === true ? "in the installed build" : value === false ? "not in the installed build yet" : null;
}

function ProofPr({ pr }: { pr: StapleConsoleProofPullRequest | StapleConsoleCard["pullRequests"][number] }) {
  const installed = pr.state === "merged" ? installedText(pr.inInstalledBuild) : null;
  return (
    <li className="[overflow-wrap:anywhere]">
      <a href={pr.url} target="_blank" rel="noreferrer" className="underline">{pr.label}</a>
      <span className="text-muted-foreground">
        {" "}{stapleConsolePrStatusText(pr)}
        {pr.state === "merged" ? ` · CI ${pr.ci === "unknown" || pr.ci === "none" ? "unknown" : pr.ci}` : ""}
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
          <p className="text-xs text-muted-foreground">{cardSecondary(card)}</p>
        </div>
        {card.betaTag ? (
          <span className="ml-auto shrink-0 rounded border border-border px-1.5 py-0.5 text-(length:--text-nano) uppercase tracking-wide text-muted-foreground">
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

      {open ? (
        <div className="mt-3 space-y-2 border-t border-border pt-2 text-xs" data-testid="staple-console-card-detail">
          {card.stuck.map((flag, index) => (
            <p key={`${flag.rule}-${flag.issueIdentifier}-${index}`} className="text-destructive" data-rule={flag.rule}>
              Stuck · {flag.issueIdentifier}: {flag.reason}
            </p>
          ))}
          {card.completionNote ? <p className="text-muted-foreground [overflow-wrap:anywhere]">{card.completionNote}</p> : null}
          <div>
            <h4 className="font-medium text-foreground">PR and CI</h4>
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
              <p className="mt-0.5 text-muted-foreground [overflow-wrap:anywhere]">{card.lastComment.excerpt}</p>
            </div>
          ) : null}
          <p className="text-(length:--text-nano) text-muted-foreground">Lane from {card.laneSource}</p>
        </div>
      ) : null}
    </article>
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
          <div className="text-xs leading-tight text-muted-foreground">{item.label}</div>
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

function AttentionList({ items, onJump }: { items: StapleConsoleAttentionItem[]; onJump: (cardId: string) => void }) {
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
  return (
    <section aria-label="Needs attention" className="space-y-2" data-testid="staple-console-attention">
      <h2 className="text-sm font-semibold text-foreground">Needs attention</h2>
      <ul className="space-y-2">
        {items.map((item, index) => (
          <li
            key={`${item.kind}-${item.identifier}-${index}`}
            data-kind={item.kind}
            className={cn(
              "rounded-md border p-2 text-xs",
              item.kind === "needs_you" ? CORAL : item.kind === "stuck" ? "border-destructive bg-destructive/5" : "border-amber-500 bg-amber-500/10",
            )}
          >
            <div className="flex items-baseline gap-1">
              <span className={cn("font-semibold", item.kind === "stuck" ? "text-destructive" : "text-foreground")}>
                {ATTENTION_LABEL[item.kind]}
              </span>
              <button type="button" onClick={() => onJump(item.cardId)} className="min-w-0 truncate font-medium text-foreground underline">
                {item.name}
              </button>
            </div>
            <p className="mt-0.5 text-foreground [overflow-wrap:anywhere]">{item.text}</p>
            <div className="mt-1 flex items-baseline justify-between gap-2">
              <span className="text-xs text-muted-foreground">{item.identifier}</span>
              {/^https?:/.test(item.href) ? (
                <a href={item.href} target="_blank" rel="noreferrer" className="font-medium underline">{item.linkLabel}</a>
              ) : (
                <Link to={item.href} className="font-medium underline">{item.linkLabel}</Link>
              )}
            </div>
          </li>
        ))}
      </ul>
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

function ClaimProof({ claim, installedBuild, now }: { claim: StapleConsoleClaim; installedBuild: string | null; now: number }) {
  const { pullRequests, reviews, acceptance } = claim.proof;
  return (
    <div className="space-y-1 rounded-md bg-muted/50 p-2 text-xs" data-testid="staple-console-proof">
      <h5 className="font-medium text-foreground">Proof</h5>
      {pullRequests.length > 0 ? (
        <ul className="space-y-0.5">{pullRequests.map((pr) => <ProofPr key={pr.url} pr={pr} />)}</ul>
      ) : (
        <p className="text-muted-foreground">No PR linked</p>
      )}
      {reviews.map((review) => (
        <p key={`${review.issueIdentifier}-${review.at}`} className="text-muted-foreground">
          Review {review.outcome === "approved" ? "approved" : "changes requested"} by {review.reviewerName ?? "unknown"} on {review.issueIdentifier}, {since(review.at, now) ?? "unknown"} ago
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
      <p className="text-muted-foreground">Installed build: {installedBuild ?? <Unknown />}</p>
    </div>
  );
}

function ClaimRow({
  claim,
  open,
  onToggle,
  renderCard,
  installedBuild,
  now,
}: {
  claim: StapleConsoleClaim;
  open: boolean;
  onToggle: () => void;
  renderCard: (cardId: string) => ReactNode;
  installedBuild: string | null;
  now: number;
}) {
  return (
    <li data-testid="staple-console-claim" data-state={claim.state} className="py-1.5">
      <Disclosure open={open} onToggle={onToggle} label={`${claim.text}, ${open ? "collapse" : "expand"}`} className="items-start">
        <Dot state={claim.state} className="mt-1" />
        <span className="min-w-0">
          <span className="block text-xs font-medium text-foreground [overflow-wrap:anywhere]">{claim.text}</span>
          {claim.why ? (
            <span className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">Why: {claim.why}</span>
          ) : null}
        </span>
      </Disclosure>
      {open ? (
        <div className="ml-4 mt-1 space-y-2">
          <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{claim.stateReason}</p>
          {claim.cardIds.map((cardId) => <div key={cardId}>{renderCard(cardId)}</div>)}
          {claim.cardIds.length === 0 && claim.tasks.length > 0 ? (
            <ul className="text-xs text-muted-foreground">
              {claim.tasks.map((task) => (
                <li key={task.identifier}>
                  <Link to={`/issues/${task.identifier}`} className="underline">{task.identifier}</Link>
                  {" "}{task.name} · {task.status.replace(/_/g, " ")}
                </li>
              ))}
            </ul>
          ) : null}
          <ClaimProof claim={claim} installedBuild={installedBuild} now={now} />
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
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground" data-testid="staple-console-legend">
        <span className="flex items-center gap-1"><Dot state="green" /> Works now, with proof</span>
        <span className="flex items-center gap-1"><Dot state="blue" /> Being fixed or built</span>
        <span className="flex items-center gap-1"><Dot state="red" /> Needs attention, nothing fixing it</span>
      </p>
      {!capabilities?.source.available ? (
        <p className="text-xs text-muted-foreground">
          Capability map <Unknown />
          {capabilities?.source.detail ? <span className="block text-xs">{capabilities.source.detail}</span> : null}
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

export function StapleConsoleBoardView({ board, now }: { board: StapleConsoleBoard; now: number }) {
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
  const shipped = cards.filter((target) => target.shipped);
  const upNextOpen = isOpen("upnext");

  return (
    <div className="space-y-5">
      {board.maintenanceHold ? <MaintenanceHoldBanner hold={board.maintenanceHold} /> : null}

      {/* Level 1: is anything stalled or waiting on me? */}
      <HeaderTiles header={board.header} />
      <AttentionList items={board.attention ?? []} onJump={jump} />

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
          <p className="text-xs text-muted-foreground">PR state from Paperclip records, not live GitHub</p>
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
        <section aria-label="Shipped today" className="space-y-1" data-testid="staple-console-shipped">
          <h2 className="text-sm font-semibold text-foreground">
            Shipped today <span className="font-normal text-muted-foreground">· {shipped.length}</span>
          </h2>
          <ul className="divide-y divide-border rounded-md border border-border text-xs">
            {shipped.map((target) => {
              const merged = target.pullRequests.find((pr) => pr.state === "merged");
              return (
                <li key={target.id} className="flex items-baseline gap-2 px-2 py-1.5">
                  <Dot state={target.completion === "merged" ? "green" : "blue"} />
                  <span className="min-w-0 flex-1 truncate text-foreground">{target.name}</span>
                  {merged ? (
                    <a href={merged.url} target="_blank" rel="noreferrer" className="shrink-0 text-muted-foreground underline">
                      {target.identifier} · #{merged.label.split("#").pop()}
                    </a>
                  ) : (
                    <Link to={`/issues/${target.identifier}`} className="shrink-0 text-muted-foreground underline">{target.identifier}</Link>
                  )}
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

      <section aria-label="Scheduled and waiting" className="space-y-1">
        <h2 className="text-sm font-semibold text-foreground">Scheduled and waiting</h2>
        <div className="grid grid-cols-2 gap-2">
          {board.scheduled.map((event, index) => (
            <div key={`${event.label}-${index}`} className="rounded-md border border-border p-2 text-xs" title={event.detail ?? undefined}>
              <div className="font-medium text-foreground">{event.label}</div>
              <div className="text-muted-foreground">
                {event.at ? clock(event.at) : event.available ? "not scheduled" : <Unknown />}
              </div>
            </div>
          ))}
        </div>
      </section>

      <p className="text-(length:--text-nano) text-muted-foreground">
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
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1"><h1 className="text-xl font-semibold text-foreground">Staple Console</h1><Link to="/system-atlas" className="text-sm font-medium underline underline-offset-2">System Atlas</Link></div>
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
          <StapleConsoleBoardView board={board} now={now} />
        </div>
      )}
    </div>
  );
}
