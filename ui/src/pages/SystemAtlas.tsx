import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, BookOpen, ChevronDown, ChevronRight, House } from "lucide-react";
import { STAPLE_CONSOLE_POLL_MS, stapleConsoleFreshness } from "@paperclipai/shared/staple-console";
import { Link } from "@/lib/router";
import { agentsApi } from "@/api/agents";
import { stapleConsoleApi } from "@/api/staple-console";
import { EmptyState } from "@/components/EmptyState";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { cn } from "@/lib/utils";
import { atlasAffectedNodes, atlasChapters, atlasOverviewPaths, atlasOverviewStages, atlasWalkthroughs } from "./system-atlas-data";

function short(value: string | null | undefined) { return value?.slice(0, 12) ?? "unknown"; }

export function SystemAtlas() {
  const { selectedCompanyId, companies } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [chapterId, setChapterId] = useState(atlasChapters[0]!.id);
  const [view, setView] = useState<"overview" | "chapters">("overview");
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [depth, setDepth] = useState<"summary" | "workings" | "evidence">("summary");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { setBreadcrumbs([{ label: "System Atlas" }]); }, [setBreadcrumbs]);
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") setNow(Date.now()); }, 1000);
    return () => window.clearInterval(timer);
  }, []);
  const query = useQuery({
    queryKey: ["system-atlas-board", selectedCompanyId],
    queryFn: () => stapleConsoleApi.board(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: STAPLE_CONSOLE_POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  const agents = useQuery({
    queryKey: ["system-atlas-agents", selectedCompanyId],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: STAPLE_CONSOLE_POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  const sourceQuery = useQuery({
    queryKey: ["system-atlas-source", selectedCompanyId],
    queryFn: () => stapleConsoleApi.source(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: STAPLE_CONSOLE_POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  const board = query.data;
  const source = sourceQuery.data;
  const affected = useMemo(() => new Set(atlasAffectedNodes(source?.changedPaths ?? [])), [source?.changedPaths]);
  const chapter = atlasChapters.find((item) => item.id === chapterId) ?? atlasChapters[0]!;
  const freshness = stapleConsoleFreshness(query.dataUpdatedAt || null, now);
  const sourceFreshness = stapleConsoleFreshness(source?.observedAt ? Date.parse(source.observedAt) : null, now);
  const waiting = board?.lanes.flatMap((lane) => lane.cards).filter((card) => card.waitingOn.length > 0).length ?? null;
  const staleData = freshness.stale || sourceFreshness.stale || Boolean(query.error) || Boolean(sourceQuery.error);
  function openNode(id: string) {
    const owner = atlasChapters.find((item) => item.nodes.some((node) => node.id === id));
    if (!owner) return;
    setChapterId(owner.id);
    setView("chapters");
    setNodeId(id);
    setDepth("summary");
    window.setTimeout(() => document.getElementById(`atlas-${id}`)?.scrollIntoView({ block: "start", behavior: "smooth" }), 0);
  }
  if (!selectedCompanyId) return <EmptyState icon={BookOpen} message={companies.length ? "Select an organization to view its System Atlas." : "Create an organization to view the System Atlas."} />;
  return <main className="mx-auto w-full max-w-5xl space-y-5 pb-12" data-testid="system-atlas">
    <header className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Staple · System Atlas</p><h1 className="text-2xl font-semibold">How the system works</h1></div>
        <div className="flex flex-wrap gap-2">
          {view === "chapters" ? <button type="button" onClick={() => setView("overview")} className="inline-flex min-h-10 items-center gap-1 rounded-md border px-3 py-2 text-sm font-medium hover:bg-accent"><ArrowLeft className="size-4" aria-hidden />Back</button> : <Link to="/console" className="inline-flex min-h-10 items-center gap-1 rounded-md border px-3 py-2 text-sm font-medium hover:bg-accent"><ArrowLeft className="size-4" aria-hidden />Back</Link>}
          <Link to="/console" className="inline-flex min-h-10 items-center gap-1 rounded-md border px-3 py-2 text-sm font-medium hover:bg-accent"><House className="size-4" aria-hidden />Home</Link>
        </div>
      </div>
      <p className="max-w-2xl text-sm text-muted-foreground">Follow one example from request to observed result in 5–10 minutes. Open the seven detailed chapters whenever you want to inspect how it works.</p>
    </header>
    <section className={cn("grid gap-2 rounded-xl border bg-card p-3 text-xs sm:grid-cols-3", staleData && "opacity-70")} aria-label="Atlas revisions and observation">
      <div><span className="text-muted-foreground">Source revision</span><strong className="block font-mono text-sm">{short(source?.sourceRevision)}</strong></div>
      <div><span className="text-muted-foreground">Installed revision</span><strong className="block font-mono text-sm">{short(source?.installedRevision)}</strong></div>
      <div><span className="text-muted-foreground">Observed</span><strong className="block text-sm">{board ? new Date(board.generatedAt).toLocaleString() : "unknown"}</strong><span className="text-muted-foreground">Source checked {source ? new Date(source.observedAt).toLocaleString() : "unknown"}</span></div>
      <p className="sm:col-span-3 text-muted-foreground" role="status">
        {staleData ? "Live facts stale or unavailable · showing last loaded evidence. " : `${freshness.label}. `}
        {source?.status === "unknown" || !source ? "Source comparison unknown." : source.status === "changed" ? `${affected.size} explanation nodes affected by newer source.` : "Explanations match the compared source paths."}
      </p>
      {query.error ? <p className="sm:col-span-3 text-destructive">Refresh failed: {query.error instanceof Error ? query.error.message : "request failed"}</p> : null}
    </section>
    <section className="grid grid-cols-3 gap-2 text-center text-xs" aria-label="Current company facts">
      <div className="rounded-lg border p-2"><strong className="block text-lg">{agents.data?.length ?? "?"}</strong>configured agents</div>
      <div className="rounded-lg border p-2"><strong className="block text-lg">{waiting ?? "?"}</strong>waiting cards</div>
      <div className="rounded-lg border p-2"><strong className="block text-lg">{board?.maintenanceHold ? "Active" : board ? "Clear" : "?"}</strong>maintenance hold</div>
    </section>
    {agents.error ? <p className="text-xs text-muted-foreground">Agent roster unavailable; last loaded roster remains visible when present.</p> : null}
    {view === "overview" ? <div className="space-y-5" data-testid="atlas-overview">
      <section className="space-y-3" aria-label="Guided result flow">
        <div className="rounded-xl border bg-card p-4"><p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Start · illustrative example</p><h2 className="text-xl font-semibold">From request to a trustworthy result</h2><p className="text-sm text-muted-foreground">This shows the intended delivery path for the Item artwork request. The current source, installed build and observed behavior are reported separately above.</p></div>
        <ol className="space-y-2">{atlasOverviewStages.map((stage, index) => <li key={stage.title} className="flex gap-3 rounded-xl border bg-card p-4">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground" aria-hidden>{index + 1}</span>
          <div className="min-w-0 flex-1 space-y-1"><h3 className="font-semibold">{stage.title}</h3><p className="text-sm">{stage.detail}</p><p className="text-xs text-muted-foreground">{stage.owner}</p><button type="button" onClick={() => openNode(stage.node)} className="inline-flex min-h-10 items-center gap-1 text-sm font-medium text-primary underline underline-offset-2">How this stage works <ArrowRight className="size-4" aria-hidden /></button></div>
        </li>)}</ol>
        <p className="rounded-xl border bg-card p-4 text-sm"><strong>Finish means observed use.</strong> A merged PR is source evidence; the installed revision and real phone behavior establish whether the result is usable. Unknown observations stay unknown.</p>
      </section>
      <section className="space-y-2" aria-label="Corrections and founder decisions"><h2 className="text-lg font-semibold">If the path changes</h2><div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-xl border bg-card p-4 text-sm"><h3 className="font-semibold">Correction loop</h3><p>A failed check or review finding returns to the engineer, then the changed head goes through CI and focused review again.</p><button type="button" onClick={() => openNode("correction")} className="min-h-10 text-primary underline underline-offset-2">See correction evidence</button></div>
        <div className="rounded-xl border bg-card p-4 text-sm"><h3 className="font-semibold">Recovery loop</h3><p>Paperclip records the failed run or wait; the assigned owner retries or replaces the session. An unresolved decision reaches Ethan.</p><button type="button" onClick={() => openNode("retry")} className="min-h-10 text-primary underline underline-offset-2">See recovery ownership</button></div>
      </div><p className="text-sm text-muted-foreground">Ethan decides the desired outcome and any real hard-stop action. The coordinator handles ordinary fixes, review and source merge under the current task authority.</p></section>
      <section className="space-y-2" aria-label="Optional Atlas paths"><h2 className="text-lg font-semibold">Explore only what you need</h2><div className="grid gap-2 md:grid-cols-3">{atlasOverviewPaths.map((path) => <article key={path.title} className="rounded-xl border bg-card p-4"><h3 className="font-semibold">{path.title}</h3><p className="mt-1 text-sm text-muted-foreground">{path.summary}</p><div className="mt-2 flex flex-wrap gap-2">{path.nodes.map((id) => <button key={id} type="button" onClick={() => openNode(id)} className="min-h-10 text-left text-sm text-primary underline underline-offset-2">{atlasChapters.flatMap((c) => c.nodes).find((node) => node.id === id)?.title}</button>)}</div></article>)}</div></section>
      <section className="rounded-xl border bg-card p-4 text-sm"><h2 className="font-semibold">Staple and Paperclip</h2><p>Paperclip stores company tasks, agents, runs, approvals and recovery records. Staple applies the Workflow operating rules and shows founder-facing Console and Atlas views over those native records.</p><button type="button" onClick={() => openNode("foundation")} className="min-h-10 text-primary underline underline-offset-2">Explore the boundary</button></section>
      <button type="button" onClick={() => setView("chapters")} className="inline-flex min-h-10 items-center gap-1 rounded-md border px-3 py-2 text-sm font-medium hover:bg-accent">Open all seven detailed chapters <ArrowRight className="size-4" aria-hidden /></button>
    </div> : <div className="grid gap-5 md:grid-cols-4" data-testid="atlas-chapters">
      <nav aria-label="Atlas chapters" className="flex gap-2 overflow-x-auto pb-2 md:col-span-1 md:flex-col md:overflow-visible">
        {atlasChapters.map((item, index) => <button key={item.id} type="button" aria-current={chapter.id === item.id ? "page" : undefined} onClick={() => { setChapterId(item.id); setNodeId(null); setDepth("summary"); }} className={cn("min-w-36 shrink-0 rounded-lg border px-3 py-2 text-left text-sm md:min-w-0", chapter.id === item.id ? "border-primary bg-primary/10 font-semibold" : "bg-card hover:bg-accent")}><span className="mr-2 text-xs text-muted-foreground">{String(index + 1).padStart(2, "0")}</span>{item.title}</button>)}
      </nav>
      <div className="min-w-0 space-y-5 md:col-span-3">
        <section className="rounded-xl border bg-card p-4"><p className="text-xs uppercase tracking-wider text-muted-foreground">Chapter {atlasChapters.indexOf(chapter) + 1} of 7</p><h2 className="mt-1 text-xl font-semibold">{chapter.title}</h2><p className="mt-1 text-sm text-muted-foreground">{chapter.introduction}</p></section>
        <div className="space-y-2">{chapter.nodes.map((item) => {
          const open = nodeId === item.id;
          const sourceState = source?.status === "unknown" || !source ? "unknown" : affected.has(item.id) ? "stale" : "current";
          return <article key={item.id} id={`atlas-${item.id}`} className="scroll-mt-24 rounded-xl border bg-card" data-source-state={sourceState}>
            <button type="button" className="flex w-full items-start gap-2 p-4 text-left" aria-expanded={open} onClick={() => { setNodeId(open ? null : item.id); setDepth("summary"); }}>
              {open ? <ChevronDown className="mt-0.5 size-4 shrink-0" /> : <ChevronRight className="mt-0.5 size-4 shrink-0" />}
              <span className="min-w-0 flex-1"><span className="block font-semibold">{item.title}</span><span className="mt-1 block text-sm text-muted-foreground">{item.summary}</span></span>
              <span className={cn("rounded px-1.5 py-0.5 text-(length:--text-nano) uppercase", sourceState === "stale" ? "bg-amber-500/15 text-amber-700" : "bg-muted text-muted-foreground")}>{sourceState}</span>
            </button>
            {open ? <div className="space-y-3 border-t p-4 pt-3 text-sm">
              <div className="flex flex-wrap gap-1" role="tablist" aria-label={`${item.title} detail`}>
                {(["summary", "workings", "evidence"] as const).map((level) => <button key={level} type="button" role="tab" aria-selected={depth === level} onClick={() => setDepth(level)} className={cn("rounded-md px-2.5 py-1.5 text-xs", depth === level ? "bg-primary text-primary-foreground" : "bg-muted")}>{level === "workings" ? "Inner workings" : level === "evidence" ? "Evidence and walkthroughs" : "Summary"}</button>)}
              </div>
              {depth === "summary" ? <p>{item.summary}</p> : depth === "workings" ? <p>{item.workings}</p> : <div className="space-y-2"><p>{item.evidence}</p><p className="text-xs text-muted-foreground">Source paths: {item.paths.join(", ")}</p><Link to="/console" className="underline">Open live Console evidence</Link></div>}
              {sourceState === "stale" ? <p className="rounded-md bg-amber-500/10 p-2 text-xs">A relevant source path changed after the authored explanation. This text needs semantic review. {source?.refreshIssueId ? <Link to={`/issues/${source.refreshIssueId}`} className="underline">Track the owner refresh task</Link> : "Refresh routing is unavailable."}</p> : sourceState === "unknown" ? <p className="text-xs text-muted-foreground">Source freshness could not be verified. Keep last-good evidence until comparison succeeds.</p> : null}
            </div> : null}
          </article>;
        })}</div>
      </div>
    </div>}
    {view === "chapters" ? <section className="space-y-2 rounded-xl border bg-card p-4" aria-label="Atlas walkthroughs"><h2 className="text-lg font-semibold">Walkthroughs</h2><p className="text-xs text-muted-foreground">Follow a path through linked nodes.</p><div className="grid gap-2 sm:grid-cols-2">{atlasWalkthroughs.map(([title, ...ids]) => <div key={title} className="rounded-lg border p-3"><h3 className="text-sm font-medium">{title}</h3><div className="mt-2 flex flex-wrap gap-1">{ids.map((id, index) => <span key={id} className="text-xs">{index > 0 ? <span className="mr-1 text-muted-foreground">→</span> : null}<button type="button" onClick={() => openNode(id)} className="underline underline-offset-2">{atlasChapters.flatMap((c) => c.nodes).find((node) => node.id === id)?.title ?? id}</button></span>)}</div></div>)}</div></section> : null}
  </main>;
}
