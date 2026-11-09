import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Instance maintenance window (FAC-840 C1). While a hold is active the server
 * records every wake durably but starts no new run. Runs still running at
 * `drainDeadlineAt` are parked with a queued continuation, and the hold lifts on
 * release or at `expiresAt`, whichever comes first. At most one hold is active.
 */
export const maintenanceHolds = pgTable(
  "maintenance_holds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    singletonKey: text("singleton_key").notNull().default("instance"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    drainDeadlineAt: timestamp("drain_deadline_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    reason: text("reason").notNull(),
    startedByActorType: text("started_by_actor_type").notNull(),
    startedByActorId: text("started_by_actor_id").notNull(),
    parkedAt: timestamp("parked_at", { withTimezone: true }),
    parkedRunCount: integer("parked_run_count").notNull().default(0),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releaseReason: text("release_reason"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    singleActiveIdx: uniqueIndex("maintenance_holds_single_active_idx")
      .on(table.singletonKey)
      .where(sql`${table.releasedAt} IS NULL`),
    startedIdx: index("maintenance_holds_started_idx").on(table.startedAt),
  }),
);
