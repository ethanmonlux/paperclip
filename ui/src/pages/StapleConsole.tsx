import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { LayoutDashboard } from "lucide-react";
import {
  STAPLE_CONSOLE_POLL_MS,
  formatStapleConsoleDuration,
  stapleConsoleFreshness,
  stapleConsolePrStatusText,
  type StapleConsoleBoard,
  type StapleConsoleCard,
  type StapleConsoleStepCell,
} from "@paperclipai/shared/staple-console";
import { Link } from "@/lib/router";
import { stapleConsoleApi } from "../api/staple-console";
import { EmptyState } from "../components/EmptyState";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { cn } from "../lib/utils";

/**
 * Staple Console (FAC-620): read-only, phone-first founder board. All state comes
 * from `GET /companies/:id/staple-console`; this page only renders and polls.
 */

const STEP_LABELS: Record<StapleConsoleStepCell["step"], string> = {
  queued: "Queued",
  build: "Build",
  ci: "CI",
  review: "Review",
  merged: "Merged",
};

const CORAL = "border-[#f0714f] bg-[#f0714f]/10";

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

function since(iso: string | null, now: number) {
  if (!iso) return "unknown";
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? formatStapleConsoleDuration(now - parsed) : "unknown";
}

function clock(iso: string | null) {
  if (!iso) return "time unknown";
  return new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
}

function StepBar({ steps }: { steps: StapleConsoleStepCell[] }) {
  return (
    <ol className="grid grid-cols-5 gap-1" aria-label="Workflow step">
      {steps.map((cell) => (
        <li key={cell.step} className="min-w-0">
          <div
            className={cn(
              "h-1.5 rounded-full",
              cell.state === "done" && "bg-emerald-500",
              cell.state === "current" && "bg-sky-500",
              cell.state === "todo" && "bg-muted",
            )}
          />
          <div
            className={cn(
              "mt-1 truncate text-[11px]",
              cell.state === "current" ? "font-semibold text-foreground" : "text-muted-foreground",
            )}
            aria-current={cell.state === "current" ? "step" : undefined}
          >
            {STEP_LABELS[cell.step]}
            {cell.rounds && cell.rounds > 1 ? ` R${cell.rounds}` : ""}
          </div>
        </li>
      ))}
    </ol>
  );
}

function ConsoleCard({
  card,
  now,
  highlighted,
  onJump,
}: {
  card: StapleConsoleCard;
  now: number;
  highlighted: boolean;
  onJump: (cardId: string) => void;
}) {
  const needsEthan = card.needsEthan.length > 0;
  const stuck = card.stuck.length > 0;
  return (
    <article
      id={`console-card-${card.id}`}
      data-testid="staple-console-card"
      className={cn(
        "scroll-mt-20 rounded-lg border bg-card p-3 transition-shadow",
        needsEthan ? CORAL : stuck ? "border-destructive bg-destructive/5" : "border-border",
        highlighted && "ring-2 ring-sky-500 ring-offset-2 ring-offset-background",
      )}
    >
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link to={`/issues/${card.identifier}`} className="text-xs font-medium text-muted-foreground hover:underline">
            {card.identifier}
          </Link>
          <h3 className="text-sm font-semibold leading-snug text-foreground [overflow-wrap:anywhere]">{card.title}</h3>
        </div>
        {card.betaTag ? (
          <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            {card.betaTag === "beta" ? "Beta" : card.betaTag === "beta_preview" ? "Beta preview" : "After beta"}
          </span>
        ) : null}
      </header>

      <div className="mt-3">
        <StepBar steps={card.steps} />
      </div>

      <dl className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
        <div>
          <dt className="text-muted-foreground">In step</dt>
          <dd className="text-foreground">{since(card.stepSince, now)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Last activity</dt>
          <dd className="text-foreground">{card.lastActivityAt ? `${since(card.lastActivityAt, now)} ago` : "no run yet"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Current run</dt>
          <dd className="text-foreground">
            {card.currentRunStartedAt ? since(card.currentRunStartedAt, now) : "none"}
          </dd>
        </div>
      </dl>

      {card.needsEthan.map((item, index) => (
        <div key={`${item.issueIdentifier}-${index}`} className={cn("mt-2 rounded-md border p-2 text-xs", CORAL)}>
          <div className="font-semibold text-foreground">Needs Ethan · {item.issueIdentifier}</div>
          <p className="mt-0.5 text-foreground [overflow-wrap:anywhere]">{item.question}</p>
          <Link to={item.href} className="mt-1 inline-block font-medium underline">
            {item.kind === "approval" ? "Open approval" : item.kind === "assigned_to_user" ? "Open task" : "Answer"}
          </Link>
        </div>
      ))}

      {card.stuck.map((flag, index) => (
        <p
          key={`${flag.rule}-${flag.issueIdentifier}-${index}`}
          className="mt-2 rounded-md bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive"
          data-rule={flag.rule}
        >
          Stuck · {flag.issueIdentifier}: {flag.reason}
        </p>
      ))}

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

      {card.pullRequests.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
          {card.pullRequests.map((pr) => (
            <a
              key={pr.url}
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              className="underline"
              title={pr.source === "github" ? "Live from GitHub" : "From Paperclip records, not a live GitHub read"}
            >
              {pr.label}
              <span className="text-muted-foreground"> {stapleConsolePrStatusText(pr)}</span>
            </a>
          ))}
        </div>
      ) : null}

      <details className="mt-2 text-xs">
        <summary className="cursor-pointer text-muted-foreground">
          {card.members.length} task{card.members.length === 1 ? "" : "s"} · lane from {card.laneSource}
        </summary>
        <ul className="mt-1 space-y-0.5">
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
        {card.currentRunAgentName ? <p className="mt-1 text-muted-foreground">Running: {card.currentRunAgentName}</p> : null}
      </details>
    </article>
  );
}

function MaintenanceHoldBanner({ hold }: { hold: NonNullable<StapleConsoleBoard["maintenanceHold"]> }) {
  return (
    <div
      role="status"
      className="rounded-md border border-amber-500 bg-amber-500/10 p-2 text-xs text-foreground"
      data-testid="staple-console-maintenance-hold"
    >
      <p className="font-semibold">
        Maintenance hold since {clock(hold.since)}, {hold.queuedWakes} {hold.queuedWakes === 1 ? "wake" : "wakes"} queued
      </p>
      <p className="text-muted-foreground">
        New runs are held, not dropped.{" "}
        {hold.parkedRuns > 0
          ? `${hold.parkedRuns} parked at the drain deadline. `
          : hold.runningRuns > 0
            ? `${hold.runningRuns} still finishing until ${clock(hold.drainDeadlineAt)}. `
            : ""}
        Lifts after the upgrade, or by {clock(hold.expiresAt)} at the latest.
      </p>
    </div>
  );
}

function HeaderCounts({ header }: { header: StapleConsoleBoard["header"] }) {
  const items = [
    { label: "Merged today", value: header.mergedToday, tone: "" },
    { label: "In flight", value: header.inFlight, tone: "" },
    { label: "Needs Ethan", value: header.needsEthan, tone: header.needsEthan ? CORAL : "" },
    { label: "Stuck", value: header.stuck, tone: header.stuck ? "border-destructive bg-destructive/5" : "" },
  ];
  return (
    <div className="grid grid-cols-4 gap-2">
      {items.map((item) => (
        <div key={item.label} className={cn("rounded-md border border-border p-2 text-center", item.tone)}>
          <div className="text-lg font-semibold tabular-nums text-foreground">{item.value}</div>
          <div className="text-[10px] leading-tight text-muted-foreground">{item.label}</div>
        </div>
      ))}
    </div>
  );
}

export function StapleConsole() {
  const { selectedCompanyId, companies } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const visible = useDocumentVisible();
  const now = useNow(visible);
  const [highlighted, setHighlighted] = useState<string | null>(null);

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

  const jump = useCallback((cardId: string) => {
    setHighlighted(cardId);
    document.getElementById(`console-card-${cardId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  useEffect(() => {
    if (!highlighted) return;
    const timer = window.setTimeout(() => setHighlighted(null), 4000);
    return () => window.clearTimeout(timer);
  }, [highlighted]);

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
        <div className={cn("space-y-4 transition", stale && "opacity-60 grayscale")} data-stale={stale ? "true" : "false"}>
          {board.maintenanceHold ? <MaintenanceHoldBanner hold={board.maintenanceHold} /> : null}
          <HeaderCounts header={board.header} />

          <section aria-label="Scheduled" className="rounded-md border border-border p-2">
            <h2 className="text-xs font-semibold text-foreground">Scheduled</h2>
            <ul className="mt-1 space-y-1 text-xs">
              {board.scheduled.map((event, index) => (
                <li key={`${event.label}-${index}`}>
                  <span className="font-medium text-foreground">{event.label}</span>
                  <span className="text-muted-foreground"> · {event.at ? clock(event.at) : "not scheduled"}</span>
                  {event.detail ? <div className="text-muted-foreground [overflow-wrap:anywhere]">{event.detail}</div> : null}
                  <div className="text-[10px] text-muted-foreground">
                    Source: {event.source}
                    {event.available ? "" : " (not observed)"}
                  </div>
                </li>
              ))}
            </ul>
          </section>

          {!board.sources.github.available ? (
            <p className="rounded-md border border-dashed border-border p-2 text-xs text-muted-foreground">
              GitHub: {board.sources.github.detail}
            </p>
          ) : null}

          {board.lanes.map((lane) => (
            <section key={lane.key} aria-label={lane.label} className="space-y-2">
              <h2 className="text-sm font-semibold text-foreground">
                {lane.label} <span className="font-normal text-muted-foreground">· {lane.cards.length}</span>
              </h2>
              {lane.cards.length === 0 ? (
                <p className="text-xs text-muted-foreground">No open Staple work in this lane.</p>
              ) : (
                lane.cards.map((card) => (
                  <ConsoleCard key={card.id} card={card} now={now} highlighted={highlighted === card.id} onJump={jump} />
                ))
              )}
            </section>
          ))}

          {board.upNext.length > 0 ? (
            <section aria-label="Up next, not queued" className="space-y-1">
              <h2 className="text-sm font-semibold text-foreground">
                Up next, not queued <span className="font-normal text-muted-foreground">· {board.upNext.length}</span>
              </h2>
              <ul className="space-y-1 text-xs">
                {board.upNext.map((gap) => (
                  <li key={gap.fac} className={cn("rounded-md border p-2", gap.betaGap ? CORAL : "border-border")}>
                    <a
                      href={`https://linear.app/facette/issue/FAC-${gap.fac}`}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium underline"
                    >
                      FAC-{gap.fac}
                    </a>{" "}
                    <span className="text-foreground">{gap.title}</span>
                    <span className="text-muted-foreground">
                      {" "}· {gap.tag === "beta" ? "Beta, no Staple task" : gap.tag ? gap.tag.replace(/_/g, " ") : "tag not set"}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <p className="text-[10px] text-muted-foreground">
            Read-only. Built {clock(board.generatedAt)} from Paperclip issues, blockers, runs, interactions, approvals and
            work products. GitHub: {board.sources.github.detail}
          </p>
        </div>
      )}
    </div>
  );
}
