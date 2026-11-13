import { z } from "zod";
import {
  ISSUE_TREE_CONTROL_MODES,
  ISSUE_TREE_HOLD_RELEASE_POLICY_STRATEGIES,
} from "../constants.js";

export const issueTreeControlModeSchema = z.enum(ISSUE_TREE_CONTROL_MODES);

export const issueTreeHoldReleasePolicySchema = z
  .object({
    strategy: z.enum(ISSUE_TREE_HOLD_RELEASE_POLICY_STRATEGIES).default("manual"),
    note: z.string().trim().min(1).max(500).optional().nullable(),
  })
  .strict();

export const previewIssueTreeControlSchema = z
  .object({
    mode: issueTreeControlModeSchema,
    releasePolicy: issueTreeHoldReleasePolicySchema.optional().nullable(),
  })
  .strict();

export type PreviewIssueTreeControl = z.infer<typeof previewIssueTreeControlSchema>;

export const createIssueTreeHoldSchema = z
  .object({
    mode: issueTreeControlModeSchema,
    reason: z.string().trim().min(1).max(1000).optional().nullable(),
    releasePolicy: issueTreeHoldReleasePolicySchema.optional().nullable(),
    metadata: z.record(z.string(), z.unknown()).optional().nullable(),
    /** Pause only: who answers for the hold. Defaults to its creator. */
    ownerAgentId: z.string().uuid().optional().nullable(),
    ownerUserId: z.string().trim().min(1).optional().nullable(),
    /** Pause only: when the hold releases itself. Defaults to 12 hours after creation. */
    expiresAt: z.string().datetime({ offset: true }).optional().nullable(),
  })
  .strict();

export type CreateIssueTreeHold = z.infer<typeof createIssueTreeHoldSchema>;

export const releaseIssueTreeHoldSchema = z
  .object({
    reason: z.string().trim().min(1).max(1000).optional().nullable(),
    releasePolicy: issueTreeHoldReleasePolicySchema.optional().nullable(),
    metadata: z.record(z.string(), z.unknown()).optional().nullable(),
  })
  .strict();

export type ReleaseIssueTreeHold = z.infer<typeof releaseIssueTreeHoldSchema>;
