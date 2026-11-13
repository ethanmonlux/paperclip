-- paperclip:migration-compat online_compatible: issue_tree_holds holds only operator holds (a handful of rows); the new columns are nullable with no default, the owner key is added NOT VALID, and the backfill touches only active pause holds. The previous release never reads the new columns.
ALTER TABLE "issue_tree_holds" ADD COLUMN "owner_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "issue_tree_holds" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "issue_tree_holds" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issue_tree_holds" ADD CONSTRAINT "issue_tree_holds_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
-- A pause hold active at deploy has no expiry: it expires 12 hours after this
-- migration, and its creator answers for it until then.
UPDATE "issue_tree_holds" SET
  "expires_at" = now() + interval '12 hours',
  "owner_agent_id" = coalesce("owner_agent_id", "created_by_agent_id"),
  "owner_user_id" = coalesce("owner_user_id", "created_by_user_id")
WHERE "status" = 'active' AND "mode" = 'pause' AND "expires_at" IS NULL;
