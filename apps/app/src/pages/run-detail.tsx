import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import Prism from "prismjs";
import "prismjs/components/prism-json";
import "prismjs/components/prism-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AppShell } from "../components/app-shell";
import { trackRunCancelled, trackRunViewed } from "../lib/analytics";
import {
  type RunRecord,
  type StepExecutionRecord,
  type StepTraceEventRecord,
  apiFetch,
} from "../lib/api";
import { getToken } from "../lib/auth";

export function RunDetailPage() {
  const { runId } = useParams({ strict: false }) as { runId: string };
  const navigate = useNavigate();
  const [sseState, setSseState] = useState("disconnected");
  const [expandedStepId, setExpandedStepId] = useState<string | null>(null);

  const runQ = useQuery({
    queryKey: ["run", runId],
    queryFn: () => apiFetch<RunRecord>(`/api/runs/${runId}`),
    enabled: Boolean(runId),
    refetchInterval: 4000,
  });

  const cancelMut = useMutation({
    mutationFn: () =>
      apiFetch<{ cancelled: boolean }>(`/api/runs/${runId}/cancel`, {
        method: "POST",
        body: "{}",
      }),
    onSuccess: () => {
      trackRunCancelled(runId);
      runQ.refetch();
    },
  });

  const retryMut = useMutation({
    mutationFn: () =>
      apiFetch<RunRecord>(`/api/runs/${runId}/retry`, {
        method: "POST",
        body: "{}",
      }),
    onSuccess: (newRun) => {
      navigate({ to: "/runs/$runId", params: { runId: newRun.id } });
    },
  });

  // Track run viewed once data loads
  const runStatus = runQ.data?.status;
  useEffect(() => {
    if (runStatus) trackRunViewed(runId, runStatus);
  }, [runId, runStatus]);

  useEffect(() => {
    if (!runId) return;
    const token = getToken();
    if (!token) {
      setSseState("fallback polling");
      return;
    }
    let refreshScheduled = false;
    const scheduleRefresh = () => {
      if (refreshScheduled) return;
      refreshScheduled = true;
      window.setTimeout(() => {
        refreshScheduled = false;
        void runQ.refetch();
      }, 250);
    };
    const es = new EventSource(
      `${import.meta.env.VITE_API_URL || "http://localhost:3001"}/api/runs/${runId}/stream?token=${encodeURIComponent(token)}`,
    );
    es.onopen = () => setSseState("connected");
    es.addEventListener("trace_event", scheduleRefresh);
    es.addEventListener("step_status", scheduleRefresh);
    es.addEventListener("run_status", scheduleRefresh);
    es.onerror = () => {
      setSseState("fallback polling");
      es.close();
    };
    return () => es.close();
  }, [runId, runQ.refetch]);

  const run = runQ.data;
  const exportableTrace = useMemo(() => {
    if (!run) return [] as Array<Record<string, unknown>>;
    const out: Array<Record<string, unknown>> = [];
    for (const step of run.steps ?? []) {
      const stepId = step.stepId || step.step_id || "step";
      const stepIndex = step.stepIndex ?? step.step_index ?? null;
      const traceEvents = parseTraceEvents(
        step.traceEvents ?? step.trace_events,
      );
      for (const event of traceEvents) {
        out.push({
          run_id: runId,
          step_execution_id: step.id,
          step_id: stepId,
          step_index: stepIndex,
          step_status: step.status,
          ...event,
        });
      }
    }
    return out;
  }, [run, runId]);

  const downloadTrace = () => {
    const payload = JSON.stringify(exportableTrace, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `run-${runId.slice(0, 8)}-trace.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };
  const stats = useMemo(() => {
    if (!run) return { duration: "-", tokens: "-", cost: "-", steps: "-" };
    const dur =
      run.completedAt && run.startedAt
        ? Math.round(
            (new Date(run.completedAt).getTime() -
              new Date(run.startedAt).getTime()) /
              1000,
          )
        : undefined;
    return {
      duration: dur === undefined ? "running" : `${dur}s`,
      tokens: String(run.totalTokens ?? run.total_tokens ?? 0),
      cost: `€${((run.totalCostCents ?? run.total_cost_cents ?? 0) / 100).toFixed(2)}`,
      steps: String((run.steps ?? []).length),
    };
  }, [run]);

  const status = run?.status || "pending";

  const actions = (
    <>
      <RunStatusBadge status={status} />
      <button
        type="button"
        onClick={() => retryMut.mutate()}
        disabled={retryMut.isPending}
        className="cursor-pointer rounded-lg border border-[var(--text-muted)] px-[18px] py-2.5 text-sm font-medium text-[var(--text-secondary)] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {retryMut.isPending ? "Retrying..." : "Retry"}
      </button>
    </>
  );

  return (
    <AppShell
      title={`Run ${runId?.slice(0, 8)}...`}
      subtitle={`Pipeline run · SSE: ${sseState}`}
      actions={actions}
    >
      {runQ.isLoading ? (
        <p className="text-sm text-[var(--text-tertiary)]">Loading run...</p>
      ) : null}
      {runQ.isError ? (
        <p className="text-sm text-red-300">Failed to load run</p>
      ) : null}
      {run?.error ? (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {run.error}
        </p>
      ) : null}

      {/* Stats — cornerRadius 10, padding 20 */}
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-4 md:gap-4">
        <StatCard label="Duration" value={stats.duration} />
        <StatCard label="Tokens" value={stats.tokens} />
        <StatCard label="Cost" value={stats.cost} />
        <StatCard label="Steps" value={stats.steps} />
      </section>

      {/* Steps list — cornerRadius 10 */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-semibold">Step Execution</h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={downloadTrace}
              disabled={exportableTrace.length === 0}
              className="rounded-lg border border-[var(--divider)] px-3 py-1.5 text-sm text-[var(--text-secondary)] disabled:opacity-50"
            >
              Export trace
            </button>
            {status === "running" ? (
              <button
                type="button"
                onClick={() => cancelMut.mutate()}
                className="rounded-lg border border-red-500/40 px-3 py-1.5 text-sm text-red-300"
              >
                Cancel run
              </button>
            ) : null}
          </div>
        </div>

        {(run?.steps ?? []).map((step) => (
          <StepCard
            key={step.id}
            step={step}
            expanded={expandedStepId === step.id}
            onToggle={() =>
              setExpandedStepId((prev) => (prev === step.id ? null : step.id))
            }
          />
        ))}
        {(run?.steps ?? []).length === 0 ? (
          <div className="rounded-[10px] border border-dashed border-[var(--divider)] p-8 text-center text-sm text-[var(--text-tertiary)]">
            {run?.status === "failed"
              ? "Run failed before any step executed."
              : "No steps executed yet"}
          </div>
        ) : null}
      </section>
    </AppShell>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[10px] border border-[var(--divider)] bg-[var(--bg-surface)] p-5">
      <p
        className="text-[10px] font-semibold uppercase text-[var(--text-tertiary)]"
        style={{ fontFamily: "var(--font-mono)", letterSpacing: "1.5px" }}
      >
        {label}
      </p>
      <p
        className="mt-2 text-[28px] font-bold leading-none"
        style={{ fontFamily: "var(--font-mono)" }}
      >
        {value}
      </p>
    </div>
  );
}

function RunStatusBadge({ status }: { status: string }) {
  const isSuccess = status === "completed";
  const isRunning = status === "running";
  const isFailed = status === "failed";
  let bg = "var(--bg-inset)";
  let fg = "var(--text-tertiary)";
  if (isSuccess) {
    bg = "#22C55E20";
    fg = "#22C55E";
  }
  if (isRunning) {
    bg = "#22D3EE20";
    fg = "#22D3EE";
  }
  if (isFailed) {
    bg = "#EF444420";
    fg = "#EF4444";
  }
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold"
      style={{ background: bg, color: fg, fontFamily: "var(--font-mono)" }}
    >
      <span
        className="inline-block size-1.5 rounded-full"
        style={{ background: fg }}
      />
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

function StepCard({
  step,
  expanded,
  onToggle,
}: {
  step: StepExecutionRecord;
  expanded: boolean;
  onToggle: () => void;
}) {
  const traceEvents = parseTraceEvents(step.traceEvents ?? step.trace_events);
  const [activeTab, setActiveTab] = useState<"details" | "trace" | "logs">(
    step.status === "running" || traceEvents.length > 0 ? "trace" : "details",
  );
  const status = step.status;
  const isSuccess = status === "completed";
  const isFailed = status === "failed";
  const rawOutput = step.rawOutput || step.raw_output;
  const parsedOutput = step.parsedOutput ?? step.parsed_output;
  const promptSent = step.promptSent || step.prompt_sent;
  const toolCalls = step.toolCallsTotal ?? step.tool_calls_total ?? 0;
  const agentTrace = step.agentTrace ?? step.agent_trace;
  const agentLogsRaw = step.agentLogs ?? step.agent_logs;
  const agentLogs = parseAgentLogs(agentLogsRaw);
  const traceStatus = step.traceStatus || step.trace_status || "idle";

  const prettyParsedOutput = (() => {
    if (parsedOutput === undefined || parsedOutput === null) return null;
    if (typeof parsedOutput === "string") {
      try {
        return JSON.stringify(JSON.parse(parsedOutput), null, 2);
      } catch {
        return parsedOutput;
      }
    }
    try {
      return JSON.stringify(parsedOutput, null, 2);
    } catch {
      return String(parsedOutput);
    }
  })();

  return (
    <div
      className={`rounded-[10px] border bg-[var(--bg-surface)] p-5 ${
        isFailed
          ? "border-red-500/30"
          : isSuccess
            ? "border-emerald-500/20"
            : "border-[var(--divider)]"
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full cursor-pointer flex-col items-start gap-3 text-left sm:flex-row sm:gap-5"
      >
        {/* Left: 200px */}
        <div className="w-full shrink-0 sm:w-[200px]">
          <RunStatusBadge status={status} />
          <p className="mt-2 text-sm font-medium">
            {step.stepId || step.step_id || "step"}
          </p>
          <p
            className="text-xs text-[var(--text-tertiary)]"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            model: {step.model || "n/a"}
          </p>
        </div>
        {/* Right: metrics */}
        <div className="flex flex-1 items-center gap-6">
          <Metric
            label="Duration"
            value={`${step.durationMs || step.duration_ms || 0}ms`}
          />
          <Metric
            label="Tokens"
            value={String(
              (step.inputTokens ?? step.input_tokens ?? 0) +
                (step.outputTokens ?? step.output_tokens ?? 0),
            )}
          />
          <Metric
            label="Cost"
            value={`€${((step.costCents || step.cost_cents || 0) / 100).toFixed(2)}`}
          />
          <Metric label="Tool Calls" value={String(toolCalls)} />
          {rawOutput ? <Metric label="Output" value="✓" /> : null}
        </div>
        <div className="ml-auto pt-1 text-xs text-[var(--text-muted)]">
          {expanded ? "▲" : "▼"}
        </div>
      </button>
      {step.error ? (
        <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {step.error}
        </p>
      ) : null}
      {rawOutput ? <MarkdownOutput value={rawOutput} /> : null}
      {expanded ? (
        <div className="mt-3 grid gap-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setActiveTab("trace")}
              className={`rounded px-2 py-1 text-xs ${
                activeTab === "trace"
                  ? "bg-[var(--accent)] text-[var(--bg-primary)]"
                  : "bg-[var(--bg-inset)] text-[var(--text-secondary)]"
              }`}
            >
              Trace {traceEvents.length > 0 ? `(${traceEvents.length})` : ""}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("details")}
              className={`rounded px-2 py-1 text-xs ${
                activeTab === "details"
                  ? "bg-[var(--accent)] text-[var(--bg-primary)]"
                  : "bg-[var(--bg-inset)] text-[var(--text-secondary)]"
              }`}
            >
              Details
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("logs")}
              className={`rounded px-2 py-1 text-xs ${
                activeTab === "logs"
                  ? "bg-[var(--accent)] text-[var(--bg-primary)]"
                  : "bg-[var(--bg-inset)] text-[var(--text-secondary)]"
              }`}
            >
              Raw Logs {agentLogs.length > 0 ? `(${agentLogs.length})` : ""}
            </button>
            {status === "running" ? (
              <span className="text-[11px] text-[var(--text-muted)]">
                live updates via SSE + polling fallback
              </span>
            ) : null}
          </div>

          {activeTab === "trace" ? (
            <StepTracePanel
              events={traceEvents}
              isRunning={status === "running"}
            />
          ) : null}
          {activeTab === "logs" ? (
            <StepLogsPanel logs={agentLogs} isRunning={status === "running"} />
          ) : null}
          {activeTab === "details" ? (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <DebugField
                  label="Step ID"
                  value={step.stepId || step.step_id || "-"}
                />
                <DebugField
                  label="Step Index"
                  value={String(step.stepIndex ?? step.step_index ?? "-")}
                />
                <DebugField
                  label="Input Tokens"
                  value={String(step.inputTokens ?? step.input_tokens ?? 0)}
                />
                <DebugField
                  label="Output Tokens"
                  value={String(step.outputTokens ?? step.output_tokens ?? 0)}
                />
                <DebugField
                  label="Retry Count"
                  value={String(step.retryCount ?? step.retry_count ?? 0)}
                />
                <DebugField
                  label="Tool Calls"
                  value={String(
                    step.toolCallsTotal ?? step.tool_calls_total ?? 0,
                  )}
                />
                <DebugField label="Trace Status" value={traceStatus} />
                <DebugField
                  label="Trace Events"
                  value={String(
                    step.traceEventCount ??
                      step.trace_event_count ??
                      traceEvents.length,
                  )}
                />
                <DebugField
                  label="Tool Cost"
                  value={`€${(((step.toolCostCents ?? step.tool_cost_cents) || 0) / 100).toFixed(2)}`}
                />
                <DebugField
                  label="Model Cost"
                  value={`€${(((step.modelCostCents ?? step.model_cost_cents) || 0) / 100).toFixed(2)}`}
                />
                <DebugField
                  label="Started At"
                  value={step.startedAt || step.started_at || "-"}
                />
                <DebugField
                  label="Completed At"
                  value={step.completedAt || step.completed_at || "-"}
                />
              </div>
              {promptSent ? (
                <DebugBlock label="Prompt Sent" value={promptSent} />
              ) : null}
              {prettyParsedOutput ? (
                <DebugBlock label="Parsed Output" value={prettyParsedOutput} />
              ) : null}
              {agentTrace ? (
                <DebugBlock
                  label="Agent Trace"
                  value={JSON.stringify(agentTrace, null, 2)}
                />
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

type AgentLogItem = {
  ts?: string;
  level?: string;
  source?: string;
  event?: string;
  message?: string;
  data?: unknown;
};

type TraceEventItem = StepTraceEventRecord;

function parseAgentLogs(value: unknown): AgentLogItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object")
    .map((item) => item as AgentLogItem);
}

function parseTraceEvents(value: unknown): TraceEventItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object")
    .map((item) => item as TraceEventItem)
    .sort((a, b) => {
      const aSeq = a.seq ?? 0;
      const bSeq = b.seq ?? 0;
      return aSeq - bSeq;
    });
}

function formatLogTime(value?: string): string {
  if (!value) return "--:--:--";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleTimeString();
}

function formatTraceTime(event: TraceEventItem): string {
  return formatLogTime(event.createdAt || event.created_at);
}

function prettyTracePayload(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function traceKindTone(kind: string): string {
  if (kind.endsWith(".failed")) return "border-red-500/30 text-red-200";
  if (kind.endsWith(".completed"))
    return "border-emerald-500/30 text-emerald-200";
  return "border-cyan-500/20 text-cyan-200";
}

function StepLogsPanel({
  logs,
  isRunning,
}: {
  logs: AgentLogItem[];
  isRunning: boolean;
}) {
  if (logs.length === 0) {
    return (
      <div className="rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] p-3 text-sm text-[var(--text-tertiary)]">
        {isRunning ? "Waiting for agent logs..." : "No agent logs recorded."}
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-2 rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] p-3">
      {logs.map((log, idx) => (
        <div
          key={`${log.ts || idx}-${idx}`}
          className="min-w-0 max-w-full rounded border border-[var(--divider)] bg-[#0a1124] p-2"
        >
          <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px]">
            <span
              className="text-cyan-200"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              {formatLogTime(log.ts)}
            </span>
            <span
              className={`rounded px-1.5 py-0.5 uppercase ${
                (log.level || "info") === "error"
                  ? "bg-red-500/20 text-red-300"
                  : (log.level || "info") === "warn"
                    ? "bg-amber-500/20 text-amber-200"
                    : "bg-cyan-500/20 text-cyan-200"
              }`}
            >
              {log.level || "info"}
            </span>
            {log.event ? (
              <span className="rounded bg-[var(--bg-surface)] px-1.5 py-0.5 text-[var(--text-secondary)]">
                {log.event}
              </span>
            ) : null}
            {log.source ? (
              <span className="text-[var(--text-muted)]">{log.source}</span>
            ) : null}
          </div>
          <p className="break-words text-sm text-[var(--text-secondary)]">
            {log.message || ""}
          </p>
          {log.data !== undefined ? (
            <pre
              className="mt-2 w-full max-w-full overflow-hidden whitespace-pre-wrap break-words rounded border border-[var(--divider)] bg-[#060d1d] p-2 text-[12px] text-cyan-100"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              {JSON.stringify(log.data, null, 2)}
            </pre>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function StepTracePanel({
  events,
  isRunning,
}: {
  events: TraceEventItem[];
  isRunning: boolean;
}) {
  if (events.length === 0) {
    return (
      <div className="rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] p-3 text-sm text-[var(--text-tertiary)]">
        {isRunning
          ? "Waiting for trace events..."
          : "No trace events recorded."}
      </div>
    );
  }

  let lastTurn: number | null = null;

  return (
    <div className="min-w-0 space-y-2 rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] p-3">
      {events.map((event, idx) => {
        const turn = typeof event.turn === "number" ? event.turn : null;
        const showTurnHeader = turn !== null && turn !== lastTurn;
        if (turn !== null) lastTurn = turn;
        const payload = prettyTracePayload(event.payload);

        return (
          <div key={`${event.id}-${idx}`} className="space-y-2">
            {showTurnHeader ? (
              <div className="rounded border border-[var(--divider)] bg-[var(--bg-surface)] px-2 py-1 text-[11px] uppercase tracking-[0.12em] text-[var(--text-muted)]">
                Turn {turn}
              </div>
            ) : null}
            <div className="min-w-0 max-w-full rounded border border-[var(--divider)] bg-[#0a1124] p-2">
              <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px]">
                <span
                  className="text-cyan-200"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  {formatTraceTime(event)}
                </span>
                <span
                  className={`rounded border px-1.5 py-0.5 ${traceKindTone(event.kind)}`}
                >
                  {event.kind}
                </span>
                <span className="rounded bg-[var(--bg-surface)] px-1.5 py-0.5 text-[var(--text-secondary)]">
                  seq {event.seq}
                </span>
                {event.stepSeq || event.step_seq ? (
                  <span className="text-[var(--text-muted)]">
                    step seq {event.stepSeq || event.step_seq}
                  </span>
                ) : null}
              </div>
              {payload ? (
                <pre
                  className="w-full max-w-full overflow-hidden whitespace-pre-wrap break-words rounded border border-[var(--divider)] bg-[#060d1d] p-2 text-[12px] text-cyan-100"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  {payload}
                </pre>
              ) : (
                <p className="text-sm text-[var(--text-secondary)]">
                  No payload
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MarkdownOutput({ value }: { value: string }) {
  return (
    <div className="mt-3 max-h-[360px] overflow-auto rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] p-3">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="mb-2 mt-1 text-lg font-semibold text-[var(--text-primary)]">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-2 mt-1 text-base font-semibold text-[var(--text-primary)]">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-1 mt-1 text-[15px] font-semibold text-[var(--text-primary)]">
              {children}
            </h3>
          ),
          p: ({ children }) => (
            <p className="mb-2 whitespace-pre-wrap text-sm leading-relaxed text-[var(--text-secondary)]">
              {children}
            </p>
          ),
          ul: ({ children }) => (
            <ul className="mb-2 list-disc pl-5 text-sm leading-relaxed text-[var(--text-secondary)]">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="mb-2 list-decimal pl-5 text-sm leading-relaxed text-[var(--text-secondary)]">
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="mb-1">{children}</li>,
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-cyan-300 underline decoration-cyan-600/60 underline-offset-2 hover:text-cyan-200"
            >
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="mb-2 border-l-2 border-[var(--accent)]/50 pl-3 italic text-[var(--text-tertiary)]">
              {children}
            </blockquote>
          ),
          code: ({ className, children }) => {
            const isBlock = Boolean(className?.includes("language-"));
            if (isBlock) {
              return (
                <code
                  className="block overflow-auto rounded border border-[var(--divider)] bg-[#0a1124] p-2.5 text-[13px] text-cyan-100"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  {children}
                </code>
              );
            }
            return (
              <code
                className="rounded bg-[#111a33] px-1.5 py-0.5 text-[12px] text-cyan-200"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="mb-2 overflow-auto rounded border border-[var(--divider)] bg-[#0a1124] p-2.5 text-[13px] text-cyan-100">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="mb-2 overflow-auto">
              <table className="w-full border-collapse text-sm text-[var(--text-secondary)]">
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-[var(--divider)] bg-[var(--bg-surface)] px-2 py-1 text-left font-semibold text-[var(--text-primary)]">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-[var(--divider)] px-2 py-1">
              {children}
            </td>
          ),
        }}
      >
        {value}
      </ReactMarkdown>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p
        className="text-[10px] uppercase text-[var(--text-muted)]"
        style={{ fontFamily: "var(--font-mono)", letterSpacing: "1px" }}
      >
        {label}
      </p>
      <p
        className="text-sm font-medium text-[var(--text-secondary)]"
        style={{ fontFamily: "var(--font-mono)" }}
      >
        {value}
      </p>
    </div>
  );
}

function DebugField({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3 py-2">
      <p
        className="text-[10px] uppercase text-[var(--text-muted)]"
        style={{ fontFamily: "var(--font-mono)", letterSpacing: "1px" }}
      >
        {label}
      </p>
      <p
        className="mt-1 break-words text-xs text-[var(--text-secondary)]"
        style={{ fontFamily: "var(--font-mono)" }}
      >
        {value}
      </p>
    </div>
  );
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function inferDebugLanguage(label: string): "json" | "markdown" {
  if (label === "Parsed Output" || label === "Agent Trace") return "json";
  return "markdown";
}

function DebugBlock({ label, value }: { label: string; value: string }) {
  const isAgentTrace = label === "Agent Trace";
  const language = inferDebugLanguage(label);
  const highlighted = (() => {
    try {
      if (language === "json") {
        return Prism.highlight(value, Prism.languages.json, "json");
      }
      return Prism.highlight(value, Prism.languages.markdown, "markdown");
    } catch {
      return escapeHtml(value);
    }
  })();

  return (
    <div className="min-w-0">
      <p
        className="mb-1 text-[10px] uppercase text-[var(--text-muted)]"
        style={{ fontFamily: "var(--font-mono)", letterSpacing: "1px" }}
      >
        {label}
      </p>
      <pre
        className={`run-debug-block w-full max-w-full whitespace-pre-wrap break-words rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] p-3 text-xs leading-relaxed text-[var(--text-tertiary)] ${
          isAgentTrace ? "overflow-visible" : "max-h-[220px] overflow-auto"
        }`}
        style={{ fontFamily: "var(--font-mono)" }}
      >
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: Prism generates local syntax markup from debug text. */}
        <code dangerouslySetInnerHTML={{ __html: highlighted }} />
      </pre>
    </div>
  );
}
