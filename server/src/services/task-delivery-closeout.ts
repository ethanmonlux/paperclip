import { and, desc, eq, inArray } from "drizzle-orm";
import { issueWorkProducts, type Db } from "@paperclipai/db";
import { issueDeliveryCloseoutSchema, type IssueDeliveryCloseout } from "@paperclipai/shared";

type ReadDb = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Read the latest declaration for this exact lifecycle. A declaration is only
 * useful while every referenced attachment remains published. Code still needs
 * an independently verified remote head/PR before it can qualify cleanup. */
export async function readTaskDeliveryCloseout(db: ReadDb, input: { companyId: string; issueId: string;
  workspaceId: string; lifecycleGeneration: number }): Promise<IssueDeliveryCloseout | null> {
  const rows = await db.select({ executionWorkspaceId: issueWorkProducts.executionWorkspaceId,
    metadata: issueWorkProducts.metadata }).from(issueWorkProducts).where(and(
    eq(issueWorkProducts.companyId, input.companyId), eq(issueWorkProducts.issueId, input.issueId),
    eq(issueWorkProducts.type, "delivery_closeout"), eq(issueWorkProducts.provider, "paperclip"),
    eq(issueWorkProducts.status, "active"), eq(issueWorkProducts.executionWorkspaceId, input.workspaceId),
  )).orderBy(desc(issueWorkProducts.updatedAt), desc(issueWorkProducts.id)).limit(20);
  for (const row of rows) {
    const parsed = issueDeliveryCloseoutSchema.safeParse(row.metadata?.deliveryCloseout);
    if (!parsed.success) continue;
    const closeout = parsed.data;
    if (closeout.workspaceId !== input.workspaceId || closeout.lifecycleGeneration !== input.lifecycleGeneration) continue;
    if (closeout.kind !== "artifact") return closeout;
    const ids = [...new Set(closeout.artifactWorkProductIds)];
    if (ids.length !== closeout.artifactWorkProductIds.length) return null;
    const artifacts = await db.select({ id: issueWorkProducts.id, type: issueWorkProducts.type,
      provider: issueWorkProducts.provider, status: issueWorkProducts.status, metadata: issueWorkProducts.metadata })
      .from(issueWorkProducts).where(and(eq(issueWorkProducts.companyId, input.companyId),
        eq(issueWorkProducts.issueId, input.issueId), inArray(issueWorkProducts.id, ids)));
    if (artifacts.length !== ids.length || artifacts.some(row => row.type !== "artifact" || row.provider !== "paperclip"
      || ["failed", "closed", "archived"].includes(row.status)
      || typeof row.metadata?.attachmentId !== "string" || row.metadata?.resourceRef)) return null;
    return closeout;
  }
  return null;
}
