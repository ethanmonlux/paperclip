import { Router } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import { notFound } from "../errors.js";
import type { MergeGateActor } from "../services/merge-gate/service.js";
import { mergeGateService } from "../services/merge-gate/wiring.js";
import { assertCompanyAccess, hasCompanyAccess } from "./authz.js";

const sha = z.string().regex(/^[0-9a-fA-F]{40}$/);
const mergeBody = z.object({
  repo: z.string().min(3).max(200),
  pullNumber: z.number().int().positive(),
  expectedHeadSha: sha.optional(),
  reviewIssueIds: z.array(z.string().uuid()).max(10).optional(),
  mergeMethod: z.enum(["merge", "squash", "rebase"]).optional(),
  dryRun: z.boolean().optional(),
}).strict();
const redMainBody = z.object({
  repo: z.string().min(3).max(200),
  baseRef: z.string().min(1).max(200).default("main"),
  evidence: z.string().min(1).max(4000),
  reportingIssueId: z.string().uuid().optional(),
}).strict();

function gateActor(actor: Express.Request["actor"]): MergeGateActor {
  return actor.type === "agent"
    ? { type: "agent", agentId: actor.agentId ?? null, runId: actor.runId ?? null }
    : { type: "board", userId: actor.userId ?? null };
}

/** Protected-main merge gate (FAC-840 B): the merge path agents use. */
export function mergeGateRoutes(db: Db) {
  const router = Router();
  const svc = mergeGateService(db);

  router.post("/issues/:issueId/merge-gate", async (req, res) => {
    const issueId = req.params.issueId as string;
    const [issue] = await db.select({ companyId: issues.companyId }).from(issues).where(eq(issues.id, issueId));
    if (!issue || !hasCompanyAccess(req, issue.companyId)) throw notFound("Issue not found");
    assertCompanyAccess(req, issue.companyId);
    const body = mergeBody.parse(req.body ?? {});
    res.set("cache-control", "no-store");
    res.json(await svc.evaluateAndMerge({ ...body, companyId: issue.companyId, issueId, actor: gateActor(req.actor) }));
  });

  router.post("/companies/:companyId/merge-gate/red-main", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const body = redMainBody.parse(req.body ?? {});
    if (body.reportingIssueId) {
      const [issue] = await db.select({ id: issues.id }).from(issues)
        .where(and(eq(issues.id, body.reportingIssueId), eq(issues.companyId, companyId)));
      if (!issue) throw notFound("Reporting issue not found");
    }
    res.json(await svc.reportRedMain({ companyId, repo: body.repo, baseRef: body.baseRef, evidence: body.evidence,
      reportingIssueId: body.reportingIssueId ?? null, actor: gateActor(req.actor) }));
  });

  return router;
}
