import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  PipelineStatus,
  Plan,
  RunFundingMode,
  RunStatus,
  StepStatus,
  StepTraceStatus,
  TraceEventKind,
  TriggerType,
} from "./types";

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").unique().notNull(),
  passwordHash: text("password_hash").notNull(),
  name: text("name"),
  plan: text("plan").$type<Plan>().default("free").notNull(),
  creditsRemaining: integer("credits_remaining").default(100).notNull(),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  stripePriceId: text("stripe_price_id"),
  stripeSubscriptionStatus: text("stripe_subscription_status"),
  stripeBillingInterval: text("stripe_billing_interval"),
  stripeCurrentPeriodEnd: timestamp("stripe_current_period_end", {
    withTimezone: true,
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const emailVerificationCodes = pgTable(
  "email_verification_codes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull(),
    codeHash: text("code_hash").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("email_verification_codes_email").on(table.email),
    index("email_verification_codes_expires").on(table.expiresAt),
  ],
);

export const apiKeys = pgTable("api_keys", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  keyHash: text("key_hash").notNull(),
  keyPrefix: text("key_prefix").notNull(),
  name: text("name"),
  scopes: text("scopes")
    .array()
    .default(["pipelines:read", "pipelines:execute"]),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const userSecrets = pgTable(
  "user_secrets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    pipelineId: uuid("pipeline_id").references(() => pipelines.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    encryptedValue: text("encrypted_value").notNull(), // base64-encoded AES-256-GCM ciphertext
    keyVersion: integer("key_version").default(1).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("user_secrets_user_global_name")
      .on(table.userId, table.name)
      .where(sql`${table.pipelineId} is null`),
    uniqueIndex("user_secrets_user_pipeline_name")
      .on(table.userId, table.pipelineId, table.name)
      .where(sql`${table.pipelineId} is not null`),
  ],
);

export const pipelines = pgTable("pipelines", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  name: text("name").notNull(),
  description: text("description"),
  definition: jsonb("definition").notNull(),
  version: integer("version").default(1).notNull(),
  isPublic: boolean("is_public").default(false).notNull(),
  tags: text("tags").array().default([]),
  status: text("status").$type<PipelineStatus>().default("draft").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const pipelineVersions = pgTable(
  "pipeline_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    pipelineId: uuid("pipeline_id")
      .references(() => pipelines.id, { onDelete: "cascade" })
      .notNull(),
    version: integer("version").notNull(),
    definition: jsonb("definition").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("pipeline_version_unique").on(table.pipelineId, table.version),
  ],
);

export const schedules = pgTable(
  "schedules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    pipelineId: uuid("pipeline_id")
      .references(() => pipelines.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    description: text("description"),
    cronExpression: text("cron_expression").notNull(),
    timezone: text("timezone").default("UTC").notNull(),
    inputData: jsonb("input_data").default({}).notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("schedules_next_run").on(table.nextRunAt)],
);

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    pipelineId: uuid("pipeline_id")
      .references(() => pipelines.id, { onDelete: "cascade" })
      .notNull(),
    pipelineVersion: integer("pipeline_version").notNull(),
    userId: uuid("user_id")
      .references(() => users.id)
      .notNull(),
    triggerType: text("trigger_type").$type<TriggerType>().notNull(),
    status: text("status").$type<RunStatus>().default("pending").notNull(),
    inputData: jsonb("input_data").default({}).notNull(),
    outputData: jsonb("output_data"),
    error: text("error"),
    totalTokens: integer("total_tokens").default(0).notNull(),
    totalCostCents: integer("total_cost_cents").default(0).notNull(),
    modelCostCents: integer("model_cost_cents").default(0).notNull(),
    toolCostCents: integer("tool_cost_cents").default(0).notNull(),
    toolCallsTotal: integer("tool_calls_total").default(0).notNull(),
    fundingMode: text("funding_mode")
      .$type<RunFundingMode>()
      .default("legacy")
      .notNull(),
    creditsDeducted: integer("credits_deducted").default(0).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("runs_pipeline").on(table.pipelineId),
    index("runs_user").on(table.userId),
    index("runs_status").on(table.status),
  ],
);

export const stepExecutions = pgTable(
  "step_executions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .references(() => runs.id, { onDelete: "cascade" })
      .notNull(),
    stepId: text("step_id").notNull(),
    stepIndex: integer("step_index").notNull(),
    model: text("model"),
    status: text("status").$type<StepStatus>().default("pending").notNull(),
    promptSent: text("prompt_sent"),
    rawOutput: text("raw_output"),
    parsedOutput: jsonb("parsed_output"),
    inputTokens: integer("input_tokens").default(0).notNull(),
    outputTokens: integer("output_tokens").default(0).notNull(),
    costCents: integer("cost_cents").default(0).notNull(),
    modelCostCents: integer("model_cost_cents").default(0).notNull(),
    toolCostCents: integer("tool_cost_cents").default(0).notNull(),
    toolCallsTotal: integer("tool_calls_total").default(0).notNull(),
    toolCallsSuccess: integer("tool_calls_success").default(0).notNull(),
    toolCallsFailed: integer("tool_calls_failed").default(0).notNull(),
    traceEventCount: integer("trace_event_count").default(0).notNull(),
    latestTraceSeq: integer("latest_trace_seq").default(0).notNull(),
    traceStatus: text("trace_status")
      .$type<StepTraceStatus>()
      .default("idle")
      .notNull(),
    agentTrace: jsonb("agent_trace"),
    agentLogs: jsonb("agent_logs"),
    durationMs: integer("duration_ms"),
    error: text("error"),
    retryCount: integer("retry_count").default(0).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [index("step_exec_run").on(table.runId)],
);

export const stepTraceEvents = pgTable(
  "step_trace_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    stepExecutionId: uuid("step_execution_id")
      .references(() => stepExecutions.id, { onDelete: "cascade" })
      .notNull(),
    runId: uuid("run_id")
      .references(() => runs.id, { onDelete: "cascade" })
      .notNull(),
    stepId: text("step_id").notNull(),
    seq: integer("seq").notNull(),
    stepSeq: integer("step_seq").notNull(),
    kind: text("kind").$type<TraceEventKind>().notNull(),
    turn: integer("turn"),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("step_trace_events_run").on(table.runId),
    index("step_trace_events_step_exec").on(table.stepExecutionId),
    uniqueIndex("step_trace_events_run_seq_unique").on(table.runId, table.seq),
    uniqueIndex("step_trace_events_step_exec_seq_unique").on(
      table.stepExecutionId,
      table.stepSeq,
    ),
  ],
);

export const stripeEvents = pgTable("stripe_events", {
  eventId: text("event_id").primaryKey(),
  eventType: text("event_type").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const billingDiscountCodes = pgTable(
  "billing_discount_codes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    code: text("code").notNull().unique(),
    active: boolean("active").default(true).notNull(),
    kind: text("kind").notNull(), // percent_off | free_cycles
    percentOff: integer("percent_off"),
    freeCyclesCount: integer("free_cycles_count"),
    freeCyclesInterval: text("free_cycles_interval"), // month | year
    appliesToPlan: text("applies_to_plan"), // starter | pro | null
    appliesToInterval: text("applies_to_interval"), // month | year | null
    allowedEmails: text("allowed_emails").array().default([]).notNull(),
    maxRedemptions: integer("max_redemptions"),
    redeemedCount: integer("redeemed_count").default(0).notNull(),
    stripeCouponId: text("stripe_coupon_id"),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("billing_discount_codes_code").on(table.code),
    index("billing_discount_codes_active").on(table.active),
  ],
);

export const chatSessions = pgTable(
  "chat_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    pipelineId: uuid("pipeline_id").references(() => pipelines.id, {
      onDelete: "set null",
    }),
    title: text("title"),
    modelId: text("model_id").notNull(),
    pipelineVersion: integer("pipeline_version").default(1).notNull(),
    status: text("status").default("active").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("chat_sessions_user").on(table.userId),
    index("chat_sessions_pipeline").on(table.pipelineId),
    index("chat_sessions_status").on(table.status),
  ],
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: uuid("session_id")
      .references(() => chatSessions.id, { onDelete: "cascade" })
      .notNull(),
    role: text("role").notNull(),
    content: text("content").notNull(),
    pipelineState: jsonb("pipeline_state"),
    pipelineVersion: integer("pipeline_version"),
    action: text("action"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("chat_messages_session").on(table.sessionId)],
);

export const pipelineTemplates = pgTable(
  "pipeline_templates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    category: text("category").notNull(),
    definition: jsonb("definition").notNull(),
    tags: text("tags").array().default([]).notNull(),
    isPublic: boolean("is_public").default(true).notNull(),
    usageCount: integer("usage_count").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("pipeline_templates_category").on(table.category),
    index("pipeline_templates_public").on(table.isPublic),
  ],
);
