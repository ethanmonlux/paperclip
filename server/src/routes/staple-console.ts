import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { stapleConsoleService } from "../services/staple-console.js";
import { assertCompanyAccess } from "./authz.js";

/** Read-only Staple Console board (FAC-620). */
export function stapleConsoleRoutes(db: Db) {
  const router = Router();
  const svc = stapleConsoleService(db);

  router.get("/companies/:companyId/staple-console", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.set("cache-control", "no-store");
    res.json(await svc.board(companyId, req.actor));
  });

  return router;
}
