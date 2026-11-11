import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Images } from "lucide-react";
import { issuesApi } from "@/api/issues";
import { EmptyState } from "@/components/EmptyState";
import { TextAttachmentPreview } from "@/components/task-side-panel/TaskAttachmentPanel";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { isHtmlPreview } from "@/lib/html-preview";
import { Link, useNavigate } from "@/lib/router";
import { loadAttachmentText, TEXT_PREVIEW_MAX_BYTES } from "@/lib/text-preview";

const ISSUE_ID = "0359548d-7b70-4841-88fd-090afc96e1d7";
const WORK_PRODUCT_ID = "2c02daef-04bf-4203-afc2-402b5fd331cc";

export function ItemArtwork() {
  const { selectedCompanyId, companies } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  useEffect(() => setBreadcrumbs([{ label: "Item artwork" }]), [setBreadcrumbs]);

  const products = useQuery({
    queryKey: ["item-artwork-work-products", selectedCompanyId],
    queryFn: ({ signal }) => issuesApi.listWorkProducts(ISSUE_ID, { signal, fresh: true }),
    enabled: Boolean(selectedCompanyId),
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
  const product = products.data?.find((item) => item.id === WORK_PRODUCT_ID && item.issueId === ISSUE_ID && item.companyId === selectedCompanyId);
  const attachmentId = typeof product?.metadata?.attachmentId === "string" ? product.metadata.attachmentId : null;
  const attachments = useQuery({
    queryKey: ["item-artwork-attachments", selectedCompanyId, ISSUE_ID, attachmentId],
    queryFn: () => issuesApi.listAttachments(ISSUE_ID),
    enabled: Boolean(attachmentId),
    refetchOnMount: "always",
  });
  // The saved product is a pointer, not an authorization grant. Resolve its target
  // against the task's authorized attachment list before requesting content.
  const attachment = attachments.data?.find((item) => item.id === attachmentId);
  const previewable = Boolean(attachment && attachment.byteSize <= TEXT_PREVIEW_MAX_BYTES && isHtmlPreview(attachment.contentType, attachment.originalFilename));
  const content = useQuery({
    queryKey: ["item-artwork-content", ISSUE_ID, attachmentId],
    queryFn: ({ signal }) => loadAttachmentText(`/api/attachments/${attachmentId}/content`, signal),
    enabled: previewable,
    refetchOnMount: "always",
  });

  if (!selectedCompanyId) return <EmptyState icon={Images} message={companies.length ? "Select an organization to view Item artwork." : "Create an organization to view Item artwork."} />;
  const failed = products.isError || attachments.isError || content.isError;
  const waiting = products.isPending || (attachmentId && attachments.isPending) || (previewable && content.isPending);
  return <main className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-3 pb-6" data-testid="item-artwork">
    <header className="flex flex-wrap items-center justify-between gap-2">
      <div><p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Staple · Item artwork</p><h1 className="text-2xl font-semibold">Item explorer</h1></div>
      <button type="button" onClick={() => navigate(-1)} className="rounded-md border px-3 py-2 text-sm font-medium hover:bg-accent">Back</button>
    </header>
    <p className="text-sm text-muted-foreground">Published snapshot from <Link to="/issues/STA-290" className="underline underline-offset-2">STA-290</Link>{product ? ` · pointer updated ${new Date(product.updatedAt).toLocaleString()}` : ""}. Artwork discovery and publication continue in that task.</p>
    {failed ? <div role="alert" className="rounded-lg border p-3 text-sm">Could not refresh the snapshot. {content.data ? "The last loaded preview is shown below and may be stale." : "The explorer is unavailable right now."} <button type="button" className="underline" onClick={() => { void products.refetch(); void attachments.refetch(); void content.refetch(); }}>Retry</button></div> : null}
    {waiting && !content.data ? <p role="status" className="rounded-lg border p-4 text-sm">Loading the latest published snapshot…</p> : null}
    {!waiting && !failed && (!product || !attachmentId || !attachment) ? <p role="status" className="rounded-lg border p-4 text-sm">No published explorer snapshot is available. Check <Link to="/issues/STA-290" className="underline">STA-290</Link> for publication status.</p> : null}
    {attachment && !previewable ? <p role="alert" className="rounded-lg border p-4 text-sm">The published file is not a supported HTML preview or exceeds the preview size limit. Open <Link to="/issues/STA-290" className="underline">STA-290</Link> for the attachment.</p> : null}
    {content.data && attachment ? <section aria-label="Item explorer snapshot" className="min-w-0 overflow-hidden rounded-xl border bg-card h-screen"><TextAttachmentPreview key={attachment.id} title={attachment.originalFilename ?? product?.title ?? "Item explorer"} text={content.data} markdown={false} html downloadUrl={attachment.downloadPath ?? `${attachment.contentPath}?download=1`} /></section> : null}
  </main>;
}
