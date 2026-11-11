import { z } from "zod";
import { workspaceFileRefSchema } from "./workspace-file-resource.js";
import { objectWithoutDefaults } from "./partial.js";

function attachmentContentPath(attachmentId: string): string {
  return `/api/attachments/${attachmentId}/content`;
}

export const issueWorkProductTypeSchema = z.enum([
  "preview_url",
  "runtime_service",
  "pull_request",
  "branch",
  "commit",
  "artifact",
  "document",
  "delivery_closeout",
]);

/** A task delivery declaration is scoped to one workspace lifecycle. It is a
 * durable assertion in the ordinary work-product flow, not proof that a remote
 * PR merged or that a local file was uploaded. Consumers verify those facts. */
export const issueDeliveryCloseoutSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("code"), workspaceId: z.string().guid(), lifecycleGeneration: z.number().int().nonnegative(), headSha: z.string().regex(/^[a-f0-9]{40}$/i), pullRequestUrl: z.string().url() }).strict(),
  z.object({ kind: z.literal("artifact"), workspaceId: z.string().guid(), lifecycleGeneration: z.number().int().nonnegative(), artifactWorkProductIds: z.array(z.string().guid()).min(1).max(100) }).strict(),
  z.object({ kind: z.literal("no_code"), workspaceId: z.string().guid(), lifecycleGeneration: z.number().int().nonnegative(), reason: z.string().trim().min(12).max(500) }).strict(),
]);
export type IssueDeliveryCloseout = z.infer<typeof issueDeliveryCloseoutSchema>;

export const issueWorkProductStatusSchema = z.enum([
  "active",
  "ready_for_review",
  "approved",
  "changes_requested",
  "merged",
  "closed",
  "failed",
  "archived",
  "draft",
]);

export const issueWorkProductReviewStateSchema = z.enum([
  "none",
  "needs_board_review",
  "approved",
  "changes_requested",
]);

export const attachmentArtifactWorkProductMetadataSchema = z.object({
  attachmentId: z.string().guid(),
  contentType: z.string().min(1),
  byteSize: z.number().int().nonnegative(),
  contentPath: z.string().min(1),
  openPath: z.string().min(1),
  downloadPath: z.string().min(1),
  originalFilename: z.string().optional().nullable(),
}).superRefine((value, ctx) => {
  const contentPath = attachmentContentPath(value.attachmentId);
  if (value.contentPath !== contentPath) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["contentPath"],
      message: "contentPath must point to the same-origin attachment content route",
    });
  }
  if (value.openPath !== contentPath) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["openPath"],
      message: "openPath must point to the same-origin attachment content route",
    });
  }
  if (value.downloadPath !== `${contentPath}?download=1`) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["downloadPath"],
      message: "downloadPath must point to the same-origin attachment download route",
    });
  }
});

export type AttachmentArtifactWorkProductMetadata = z.infer<typeof attachmentArtifactWorkProductMetadataSchema>;

export const issueWorkProductMetadataSchema = z
  .object({
    resourceRef: workspaceFileRefSchema.optional().nullable(),
    deliveryCloseout: issueDeliveryCloseoutSchema.optional(),
  })
  .passthrough();

export type IssueWorkProductMetadata = z.infer<typeof issueWorkProductMetadataSchema>;

const issueWorkProductBaseSchema = z.object({
  projectId: z.string().guid().optional().nullable(),
  executionWorkspaceId: z.string().guid().optional().nullable(),
  runtimeServiceId: z.string().guid().optional().nullable(),
  type: issueWorkProductTypeSchema,
  provider: z.string().min(1),
  externalId: z.string().optional().nullable(),
  title: z.string().min(1),
  url: z.string().url().optional().nullable(),
  status: issueWorkProductStatusSchema.default("active"),
  reviewState: issueWorkProductReviewStateSchema.optional().default("none"),
  isPrimary: z.boolean().optional().default(false),
  healthStatus: z.enum(["unknown", "healthy", "unhealthy"]).optional().default("unknown"),
  summary: z.string().optional().nullable(),
  metadata: issueWorkProductMetadataSchema.optional().nullable(),
  createdByRunId: z.string().guid().optional().nullable(),
});

export const createIssueWorkProductSchema = issueWorkProductBaseSchema;

export type CreateIssueWorkProduct = z.infer<typeof createIssueWorkProductSchema>;

export const updateIssueWorkProductSchema = objectWithoutDefaults(
  issueWorkProductBaseSchema,
).partial();

export type UpdateIssueWorkProduct = z.infer<typeof updateIssueWorkProductSchema>;
