import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  updateFounderNotificationRouteSchema,
  upsertFounderNotificationRouteSchema,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService } from "../services/access.js";
import { founderNotificationAttentionSource } from "../services/founder-notification-attention.js";
import { logActivity } from "../services/activity-log.js";
import { founderNotificationService } from "../services/founder-notifications.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

/**
 * Board surface for founder phone notifications: inspect routes and every
 * episode's delivery state, manage the single recipient route, and
 * acknowledge from Paperclip when a provider has no native button.
 */
export function founderNotificationRoutes(
  db: Db,
  service = founderNotificationService(db, { listAttention: founderNotificationAttentionSource(db) }),
) {
  const router = Router();
  const access = accessService(db);

  // Same authority as configuring the chat endpoint the route delivers through.
  async function assertConnectionManager(req: Request, companyId: string) {
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    const userId = req.actor.userId;
    if (userId && (await access.hasPermission(companyId, "user", userId, "tools:manage_connections"))) return;
    throw forbidden("Missing permission: tools:manage_connections");
  }

  router.get("/companies/:companyId/founder-notifications", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const [routes, episodes] = await Promise.all([service.listRoutes(companyId), service.listEpisodes(companyId)]);
    res.json({ routes, episodes });
  });

  router.put(
    "/companies/:companyId/founder-notifications/routes",
    validate(upsertFounderNotificationRouteSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertConnectionManager(req, companyId);
      const route = await service.upsertRoute(companyId, req.body, req.actor.userId ?? null);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "founder_notification.route_saved",
        entityType: "chat_endpoint",
        entityId: route.endpointId,
        details: {
          routeId: route.id,
          recipientUserId: route.recipientUserId,
          conversationId: route.conversationId,
          enabled: route.enabled,
          stallAfterMs: route.stallAfterMs,
        },
      });
      res.json(route);
    },
  );

  router.patch(
    "/companies/:companyId/founder-notifications/routes/:routeId",
    validate(updateFounderNotificationRouteSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertConnectionManager(req, companyId);
      const route = await service.updateRoute(
        companyId,
        req.params.routeId as string,
        req.body,
        req.actor.userId ?? null,
      );
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "founder_notification.route_updated",
        entityType: "chat_endpoint",
        entityId: route.endpointId,
        details: { routeId: route.id, enabled: route.enabled, stallAfterMs: route.stallAfterMs },
      });
      res.json(route);
    },
  );

  router.post("/companies/:companyId/founder-notifications/episodes/:episodeId/acknowledge", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const userId = req.actor.userId;
    if (!userId) throw forbidden("A signed-in recipient is required");
    const result = await service.acknowledge(companyId, req.params.episodeId as string, userId);
    if (result.acknowledged) {
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: userId,
        action: "founder_notification.acknowledged",
        entityType: "issue",
        entityId: result.episode.payload.issueId,
        details: { episodeId: result.episode.id, via: "board" },
      });
    }
    res.json({ acknowledged: result.acknowledged, acknowledgedAt: result.episode.payload.acknowledgedAt });
  });

  return router;
}
