import { Worker } from "bullmq";
import { Redis as IORedis } from "ioredis";
import { bootstrapWorkerEnv } from "./env-bootstrap.js";
import { executePipeline } from "./executor.js";
import { startScheduler } from "./scheduler.js";

bootstrapWorkerEnv();

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
console.log("🔐 Platform model keys:", {
  openai: Boolean(process.env.OPENAI_API_KEY),
  anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
  gemini: Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
  mistral: Boolean(process.env.MISTRAL_API_KEY),
  zai: Boolean(process.env.ZAI_API_KEY),
});

console.log("🔌 Connecting to Redis...");
const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

connection.on("connect", () => console.log("✅ Redis connected"));
connection.on("error", (err) => console.error("❌ Redis error:", err.message));

// Pipeline execution worker
const worker = new Worker(
  "pipeline-runs",
  async (job) => {
    const { runId } = job.data;
    console.log(`⚡ Executing run ${runId}`);
    await executePipeline(runId);
  },
  {
    connection,
    concurrency: 5,
  },
);

worker.on("completed", (job) => {
  console.log(`✅ Run ${job.data.runId} completed`);
});

worker.on("failed", (job, err) => {
  console.error(`❌ Run ${job?.data.runId} failed:`, err.message);
});

worker.on("error", (err) => {
  console.error("❌ Worker error:", err.message);
});

// Start cron scheduler
startScheduler(connection);

console.log("🏭 Stepiq Worker started");
