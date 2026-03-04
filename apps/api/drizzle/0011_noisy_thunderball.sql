CREATE TABLE "step_trace_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"step_execution_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"step_id" text NOT NULL,
	"seq" integer NOT NULL,
	"step_seq" integer NOT NULL,
	"kind" text NOT NULL,
	"turn" integer,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "step_executions" ADD COLUMN "trace_event_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "step_executions" ADD COLUMN "latest_trace_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "step_executions" ADD COLUMN "trace_status" text DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE "step_trace_events" ADD CONSTRAINT "step_trace_events_step_execution_id_step_executions_id_fk" FOREIGN KEY ("step_execution_id") REFERENCES "public"."step_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_trace_events" ADD CONSTRAINT "step_trace_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "step_trace_events_run" ON "step_trace_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "step_trace_events_step_exec" ON "step_trace_events" USING btree ("step_execution_id");--> statement-breakpoint
CREATE UNIQUE INDEX "step_trace_events_run_seq_unique" ON "step_trace_events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "step_trace_events_step_exec_seq_unique" ON "step_trace_events" USING btree ("step_execution_id","step_seq");