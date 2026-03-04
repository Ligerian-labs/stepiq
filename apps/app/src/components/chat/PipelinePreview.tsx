import type { PipelineDefinition } from "@stepiq/core";

interface PipelinePreviewProps {
  pipeline: PipelineDefinition | null;
  onApply?: () => void;
  onRun?: () => void;
}

export function PipelinePreview({
  pipeline,
  onApply,
  onRun,
}: PipelinePreviewProps) {
  if (!pipeline) {
    return (
      <div className="flex h-full items-center justify-center rounded-xl border border-[var(--divider)] bg-[var(--bg-surface)] p-6">
        <p className="text-sm text-[var(--text-muted)]">
          No pipeline generated yet. Start chatting to create one!
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col rounded-xl border border-[var(--divider)] bg-[var(--bg-surface)]">
      <div className="border-b border-[var(--divider)] p-4">
        <h3 className="text-sm font-semibold">
          {pipeline.name || "Untitled Pipeline"}
        </h3>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          Version {pipeline.version || 1} • {pipeline.steps?.length || 0} steps
        </p>
      </div>

      <div className="flex-1 overflow-auto p-4">
        <div className="space-y-3">
          {pipeline.steps?.map((step, index) => (
            <div
              key={step.id || index}
              className="rounded-lg border border-[var(--divider)] bg-[var(--bg-inset)] p-3"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <p className="text-sm font-medium">
                    {index + 1}. {step.name || step.id}
                  </p>
                  <p className="mt-1 text-xs text-[var(--text-muted)]">
                    Type: {step.type} • Model: {step.model || "default"}
                  </p>
                </div>
                <span className="rounded bg-[var(--bg-surface)] px-2 py-1 text-xs">
                  {step.type}
                </span>
              </div>
              {step.prompt && (
                <p className="mt-2 text-xs text-[var(--text-secondary)] line-clamp-2">
                  {step.prompt}
                </p>
              )}
            </div>
          ))}
        </div>

        {pipeline.variables && Object.keys(pipeline.variables).length > 0 && (
          <div className="mt-4">
            <h4 className="mb-2 text-xs font-semibold text-[var(--text-muted)]">
              Variables
            </h4>
            <div className="space-y-1">
              {Object.entries(pipeline.variables).map(([key, value]) => (
                <div
                  key={key}
                  className="flex items-center justify-between rounded bg-[var(--bg-inset)] px-2 py-1 text-xs"
                >
                  <span className="font-mono">{key}</span>
                  <span className="text-[var(--text-muted)]">
                    {String(value)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-[var(--divider)] p-4">
        <div className="flex gap-2">
          {onApply && (
            <button
              type="button"
              onClick={onApply}
              className="flex-1 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--bg-primary)]"
            >
              Apply to Editor
            </button>
          )}
          {onRun && (
            <button
              type="button"
              onClick={onRun}
              className="flex-1 rounded-lg border border-[var(--divider)] px-4 py-2 text-sm font-medium"
            >
              Run Pipeline
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
