import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { chatMessages, chatSessions, pipelines, users } from "../db/schema.js";

interface SecurityEvent {
  type:
    | "input_rejection"
    | "output_rejection"
    | "injection_attempt"
    | "rate_limit";
  userId: string;
  sessionId?: string;
  severity: "low" | "medium" | "high" | "critical";
  details: Record<string, unknown>;
}

export async function logSecurityEvent(event: SecurityEvent): Promise<void> {
  console.error(
    `[SECURITY] ${event.type}: ${event.severity} - User: ${event.userId}`,
    event.details,
  );

  if (event.severity === "critical") {
    console.error("[SECURITY ALERT] Critical security event detected:", event);
  }
}

export async function checkRateLimit(
  userId: string,
  action: "message" | "pipeline_create",
): Promise<{ allowed: boolean; remaining: number; resetAt?: Date }> {
  const limits = {
    message: { max: 50, window: 3600 },
    pipeline_create: { max: 10, window: 3600 },
  };

  const limit = limits[action];
  const windowStart = new Date(Date.now() - limit.window * 1000);

  let current = 0;
  let resetAt: Date | undefined;

  if (action === "message") {
    const sessions = await db
      .select({ id: chatSessions.id })
      .from(chatSessions)
      .where(eq(chatSessions.userId, userId));
    const sessionIds = sessions.map((session) => session.id);

    if (sessionIds.length > 0) {
      const countResult = await db
        .select({ count: sql<number>`count(*)` })
        .from(chatMessages)
        .where(
          and(
            inArray(chatMessages.sessionId, sessionIds),
            gte(chatMessages.createdAt, windowStart),
          ),
        );
      current = Number(countResult[0]?.count || 0);

      if (current >= limit.max) {
        const oldest = await db
          .select({ createdAt: chatMessages.createdAt })
          .from(chatMessages)
          .where(
            and(
              inArray(chatMessages.sessionId, sessionIds),
              gte(chatMessages.createdAt, windowStart),
            ),
          )
          .orderBy(asc(chatMessages.createdAt))
          .limit(1);
        const createdAt = oldest[0]?.createdAt;
        if (createdAt instanceof Date) {
          resetAt = new Date(createdAt.getTime() + limit.window * 1000);
        }
      }
    }
  } else {
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(pipelines)
      .where(and(eq(pipelines.userId, userId), gte(pipelines.createdAt, windowStart)));
    current = Number(countResult[0]?.count || 0);

    if (current >= limit.max) {
      const oldest = await db
        .select({ createdAt: pipelines.createdAt })
        .from(pipelines)
        .where(and(eq(pipelines.userId, userId), gte(pipelines.createdAt, windowStart)))
        .orderBy(asc(pipelines.createdAt))
        .limit(1);
      const createdAt = oldest[0]?.createdAt;
      if (createdAt instanceof Date) {
        resetAt = new Date(createdAt.getTime() + limit.window * 1000);
      }
    }
  }
  const allowed = current < limit.max;

  if (!allowed) {
    await logSecurityEvent({
      type: "rate_limit",
      userId,
      severity: "medium",
      details: { action, current, limit: limit.max },
    });
  }

  return {
    allowed,
    remaining: Math.max(0, limit.max - current),
    resetAt,
  };
}

export async function getUserSecurityContext(
  userId: string,
  sessionId: string,
): Promise<{
  userId: string;
  sessionId: string;
  permissionLevel: string;
  rateLimitStatus: string;
}> {
  const [user] = await db
    .select({ plan: users.plan })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const rateLimit = await checkRateLimit(userId, "message");

  return {
    userId,
    sessionId,
    permissionLevel: user?.plan || "free",
    rateLimitStatus: rateLimit.allowed ? "ok" : "exceeded",
  };
}
