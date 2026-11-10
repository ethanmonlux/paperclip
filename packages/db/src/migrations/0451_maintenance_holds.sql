CREATE TABLE "maintenance_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"singleton_key" text DEFAULT 'instance' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"drain_deadline_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"started_by_actor_type" text NOT NULL,
	"started_by_actor_id" text NOT NULL,
	"parked_at" timestamp with time zone,
	"parked_run_count" integer DEFAULT 0 NOT NULL,
	"released_at" timestamp with time zone,
	"release_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_holds_single_active_idx" ON "maintenance_holds" USING btree ("singleton_key") WHERE "maintenance_holds"."released_at" IS NULL;--> statement-breakpoint
CREATE INDEX "maintenance_holds_started_idx" ON "maintenance_holds" USING btree ("started_at");