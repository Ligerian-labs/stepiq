import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { Env } from "./lib/env.js";
import { apiKeyRoutes } from "./routes/api-keys.js";
import { authRoutes } from "./routes/auth.js";
import { billingRoutes } from "./routes/billing.js";
import { chatRoutes } from "./routes/chat.js";
import { modelRoutes } from "./routes/models.js";
import { pipelineRoutes } from "./routes/pipelines.js";
import { runRoutes } from "./routes/runs.js";
import { scheduleRoutes } from "./routes/schedules.js";
import { secretRoutes } from "./routes/secrets.js";
import { userRoutes } from "./routes/user.js";
import { webhookRoutes } from "./routes/webhooks.js";

export const app = new Hono<{ Variables: Env }>();

// Middleware
app.use("*", logger());
app.use(
  "*",
  cors({
    origin: process.env.CORS_ORIGIN || "http://localhost:4321",
    credentials: true,
  }),
);

// Body size limit (256KB max)
app.use(
  "*",
  bodyLimit({
    maxSize: 256 * 1024,
    onError: (c) =>
      c.json({ error: "Request body too large (max 256KB)" }, 413),
  }),
);

// Health check
app.get("/health", (c) => c.json({ status: "ok", version: "0.0.1" }));

// Routes
app.route("/api/auth", authRoutes);
app.route("/api/chat", chatRoutes);
app.route("/api/pipelines", pipelineRoutes);
app.route("/api/runs", runRoutes);
app.route("/api/schedules", scheduleRoutes);
app.route("/api/models", modelRoutes);
app.route("/api/billing", billingRoutes);
app.route("/api/user/api-keys", apiKeyRoutes);
app.route("/api/user", userRoutes);
app.route("/api/webhooks", webhookRoutes);
app.route("/api/user/secrets", secretRoutes);

// 404
app.notFound((c) => c.json({ error: "Not found" }, 404));

// Error handler
app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json({ error: "Internal server error" }, 500);
});
