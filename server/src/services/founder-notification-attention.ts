import type { Db } from "@paperclipai/db";
import { attentionService } from "./attention.js";
import type { FounderNotificationSweepDeps } from "./founder-notifications.js";

/**
 * The recipient's complete desk: their own dismissals, their read boundary,
 * and every page at once, so absence from the snapshot reliably means the
 * fact cleared. A feed failure throws and therefore resolves nothing.
 */
export function founderNotificationAttentionSource(db: Db): FounderNotificationSweepDeps["listAttention"] {
  const attention = attentionService(db);
  return async (companyId, recipientUserId, actor) =>
    (
      await attention.list(companyId, {
        userId: recipientUserId,
        actor,
        includeDismissed: true,
        all: true,
        allowUnscopedAll: true,
      })
    ).items;
}
