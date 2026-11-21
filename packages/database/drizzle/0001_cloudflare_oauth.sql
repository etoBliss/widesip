ALTER TABLE "domains" ADD COLUMN "cloudflare_zone_id" text;
--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "cloudflare_zone_name" text;
--> statement-breakpoint
CREATE TABLE "cloudflare_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"domain_id" uuid NOT NULL,
	"connected_by_user_id" text NOT NULL,
	"access_token_encrypted" text NOT NULL,
	"refresh_token_encrypted" text NOT NULL,
	"access_token_expires_at" timestamp NOT NULL,
	"scopes" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cloudflare_connections" ADD CONSTRAINT "cloudflare_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cloudflare_connections" ADD CONSTRAINT "cloudflare_connections_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cloudflare_connections" ADD CONSTRAINT "cloudflare_connections_connected_by_user_id_user_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "cloudflare_connections_domain_unique" ON "cloudflare_connections" USING btree ("domain_id");
--> statement-breakpoint
CREATE INDEX "cloudflare_connections_workspace_idx" ON "cloudflare_connections" USING btree ("workspace_id");
--> statement-breakpoint
CREATE TABLE "cloudflare_oauth_states" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"domain_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"code_verifier_encrypted" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cloudflare_oauth_states" ADD CONSTRAINT "cloudflare_oauth_states_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cloudflare_oauth_states" ADD CONSTRAINT "cloudflare_oauth_states_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cloudflare_oauth_states" ADD CONSTRAINT "cloudflare_oauth_states_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "cloudflare_oauth_states_expiry_idx" ON "cloudflare_oauth_states" USING btree ("expires_at");
