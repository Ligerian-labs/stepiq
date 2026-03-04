CREATE TABLE "billing_discount_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"kind" text NOT NULL,
	"percent_off" integer,
	"free_cycles_count" integer,
	"free_cycles_interval" text,
	"applies_to_plan" text,
	"applies_to_interval" text,
	"allowed_emails" text[] DEFAULT '{}' NOT NULL,
	"max_redemptions" integer,
	"redeemed_count" integer DEFAULT 0 NOT NULL,
	"stripe_coupon_id" text,
	"starts_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_discount_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"pipeline_state" jsonb,
	"pipeline_version" integer,
	"action" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"pipeline_id" uuid,
	"title" text,
	"model_id" text NOT NULL,
	"pipeline_version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_verification_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" text NOT NULL,
	"definition" jsonb NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"is_public" boolean DEFAULT true NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "model_cost_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "tool_cost_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "tool_calls_total" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "funding_mode" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "credits_deducted" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "step_executions" ADD COLUMN "model_cost_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "step_executions" ADD COLUMN "tool_cost_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "step_executions" ADD COLUMN "tool_calls_total" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "step_executions" ADD COLUMN "tool_calls_success" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "step_executions" ADD COLUMN "tool_calls_failed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "step_executions" ADD COLUMN "agent_trace" jsonb;--> statement-breakpoint
ALTER TABLE "step_executions" ADD COLUMN "agent_logs" jsonb;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_discount_codes_code" ON "billing_discount_codes" USING btree ("code");--> statement-breakpoint
CREATE INDEX "billing_discount_codes_active" ON "billing_discount_codes" USING btree ("active");--> statement-breakpoint
CREATE INDEX "chat_messages_session" ON "chat_messages" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "chat_sessions_user" ON "chat_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "chat_sessions_pipeline" ON "chat_sessions" USING btree ("pipeline_id");--> statement-breakpoint
CREATE INDEX "chat_sessions_status" ON "chat_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "email_verification_codes_email" ON "email_verification_codes" USING btree ("email");--> statement-breakpoint
CREATE INDEX "email_verification_codes_expires" ON "email_verification_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "pipeline_templates_category" ON "pipeline_templates" USING btree ("category");--> statement-breakpoint
CREATE INDEX "pipeline_templates_public" ON "pipeline_templates" USING btree ("is_public");