import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { STAPLE_CONSOLE_POLL_MS, stapleConsoleFreshness } from "@paperclipai/shared/staple-console";
import { Link } from "@/lib/router";
import { agentsApi } from "@/api/agents";
import { stapleConsoleApi } from "@/api/staple-console";
import { EmptyState } from "@/components/EmptyState";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { cn } from "@/lib/utils";
import { atlasAffectedNodes, atlasChapters, atlasWalkthroughs } from "./system-atlas-data";

function short(value: string | null | undefined) { return value?.slice(0, 12) ?? "unknown"; }

export function SystemAtlas() {
  const { selectedCompanyId, companies } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [chapterId, setChapterId] = useState(atlasChapters[0]!.id);
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
    setNodeId(id);
    setDepth("summary");
    window.setTimeout(() => document.getElementById(`atlas-${id}`)?.scrollIntoView({ block: "start", behavior: "smooth" }), 0);
  }
  if (!selectedCompanyId) return <EmptyState icon={BookOpen} message={companies.length ? "Select an organization to view its System Atlas." : "Create an organization to view the System Atlas."} />;
  return <main className="mx-auto w-full max-w-5xl space-y-5 pb-12" data-testid="system-atlas">
    <header className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Staple · System Atlas</p><h1 className="text-2xl font-semibold">How the system works</h1></div>
        <Link to="/console" className="inline-flex items-center gap-1 rounded-md border px-3 py-2 text-sm font-medium hover:bg-accent">Live Console <ExternalLink className="size-3.5" aria-hidden /></Link>
      </div>
      <p className="max-w-2xl text-sm text-muted-foreground">Explore the seven parts of Staple, then open current evidence. Explanations travel with source; live state comes from this company’s authorized Console data.</p>
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
    <div className="grid gap-5 md:grid-cols-[14rem_minmax(0,1fr)]">
      <nav aria-label="Atlas chapters" className="flex gap-2 overflow-x-auto pb-2 md:flex-col md:overflow-visible">
        {atlasChapters.map((item, index) => <button key={item.id} type="button" aria-current={chapter.id === item.id ? "page" : undefined} onClick={() => { setChapterId(item.id); setNodeId(null); setDepth("summary"); }} className={cn("min-w-36 shrink-0 rounded-lg border px-3 py-2 text-left text-sm md:min-w-0", chapter.id === item.id ? "border-primary bg-primary/10 font-semibold" : "bg-card hover:bg-accent")}><span className="mr-2 text-xs text-muted-foreground">{String(index + 1).padStart(2, "0")}</span>{item.title}</button>)}
      </nav>
      <div className="min-w-0 space-y-5">
        <section className="rounded-xl border bg-card p-4"><p className="text-xs uppercase tracking-wider text-muted-foreground">Chapter {atlasChapters.indexOf(chapter) + 1} of 7</p><h2 className="mt-1 text-xl font-semibold">{chapter.title}</h2><p className="mt-1 text-sm text-muted-foreground">{chapter.introduction}</p></section>
        <div className="space-y-2">{chapter.nodes.map((item) => {
          const open = nodeId === item.id;
          const sourceState = source?.status === "unknown" || !source ? "unknown" : affected.has(item.id) ? "stale" : "current";
          return <article key={item.id} id={`atlas-${item.id}`} className="scroll-mt-24 rounded-xl border bg-card" data-source-state={sourceState}>
            <button type="button" className="flex w-full items-start gap-2 p-4 text-left" aria-expanded={open} onClick={() => { setNodeId(open ? null : item.id); setDepth("summary"); }}>
              {open ? <ChevronDown className="mt-0.5 size-4 shrink-0" /> : <ChevronRight className="mt-0.5 size-4 shrink-0" />}
              <span className="min-w-0 flex-1"><span className="block font-semibold">{item.title}</span><span className="mt-1 block text-sm text-muted-foreground">{item.summary}</span></span>
              <span className={cn("rounded px-1.5 py-0.5 text-[10px] uppercase", sourceState === "stale" ? "bg-amber-500/15 text-amber-700" : "bg-muted text-muted-foreground")}>{sourceState}</span>
            </button>
            {open ? <div className="space-y-3 border-t p-4 pt-3 text-sm">
              <div className="flex flex-wrap gap-1" role="tablist" aria-label={`${item.title} detail`}>
                {(["summary", "workings", "evidence"] as const).map((level) => <button key={level} type="button" role="tab" aria-selected={depth === level} onClick={() => setDepth(level)} className={cn("rounded-md px-2.5 py-1.5 text-xs", depth === level ? "bg-primary text-primary-foreground" : "bg-muted")}>{level === "workings" ? "Inner workings" : level === "evidence" ? "Evidence and walkthroughs" : "Summary"}</button>)}
              </div>
              {depth === "summary" ? <p>{item.summary}</p> : depth === "workings" ? <p>{item.workings}</p> : <div className="space-y-2"><p>{item.evidence}</p><p className="text-xs text-muted-foreground">Source paths: {item.paths.join(", ")}</p><Link to="/console" className="underline">Open live Console evidence</Link></div>}
              {sourceState === "stale" ? <p className="rounded-md bg-amber-500/10 p-2 text-xs">A relevant source path changed after the installed explanation. This text needs semantic review. <Link to="/issues/STA-289" className="underline">Track refresh on STA-289</Link>.</p> : sourceState === "unknown" ? <p className="text-xs text-muted-foreground">Source freshness could not be verified. Keep last-good evidence until comparison succeeds.</p> : null}
            </div> : null}
          </article>;
        })}</div>
      </div>
    </div>
    <section className="space-y-2 rounded-xl border bg-card p-4" aria-label="Atlas walkthroughs"><h2 className="text-lg font-semibold">Walkthroughs</h2><p className="text-xs text-muted-foreground">Follow a path through linked nodes.</p><div className="grid gap-2 sm:grid-cols-2">{atlasWalkthroughs.map(([title, ...ids]) => <div key={title} className="rounded-lg border p-3"><h3 className="text-sm font-medium">{title}</h3><div className="mt-2 flex flex-wrap gap-1">{ids.map((id, index) => <span key={id} className="text-xs">{index > 0 ? <span className="mr-1 text-muted-foreground">→</span> : null}<button type="button" onClick={() => openNode(id)} className="underline underline-offset-2">{atlasChapters.flatMap((c) => c.nodes).find((node) => node.id === id)?.title ?? id}</button></span>)}</div></div>)}</div></section>
  </main>;
}
