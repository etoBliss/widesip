ALTER TABLE "campaign_recipients" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD COLUMN "available_at" timestamp DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD COLUMN "claimed_at" timestamp;
--> statement-breakpoint
CREATE INDEX "campaign_recipients_queue_idx" ON "campaign_recipients" USING btree ("status", "available_at", "created_at");
