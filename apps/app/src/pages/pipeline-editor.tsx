import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import Prism from "prismjs";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-json";
import YAML from "yaml";
import { AppShell } from "../components/app-shell";
import {
  trackPipelineDeleted,
  trackPipelineRunTriggered,
  trackPipelineSaved,
  trackSecretCreated,
  trackSecretDeleted,
  trackSecretUpdated,
} from "../lib/analytics";
import {
  ApiError,
  type PipelineRecord,
  type RunRecord,
  type SecretRecord,
  apiFetch,
} from "../lib/api";

interface StepDef {
  id: string;
  name: string;
  type: string;
  model: string;
  prompt: string;
  outputFormat?: string;
  timeout?: number;
  retries?: number;
  agentMaxTurns?: number;
  agentMaxDurationSeconds?: number;
  agentMaxToolCalls?: number;
  networkAllowlist?: string;
  tools?: StepToolDef[];
}

interface StepToolDef {
  type:
    | "http_request"
    | "extract_json"
    | "template_render"
    | "js"
    | "curl"
    | "gh"
    | "gogcli";
  name: string;
  description?: string;
  inputSchema?: string;
  jsSource?: string;
}

interface DefinitionStep {
  id?: string;
  name?: string;
  type?: string;
  model?: string;
  prompt?: string;
  outputFormat?: string;
  output_format?: string;
  timeout?: number;
  timeout_seconds?: number;
  retries?: number;
  retry?: {
    max_attempts?: number;
    backoff_ms?: number;
  };
  agent?: {
    max_turns?: number;
    max_duration_seconds?: number;
    max_tool_calls?: number;
    network_allowlist?: string[];
    tools?: Array<{
      type?:
        | "http_request"
        | "extract_json"
        | "template_render"
        | "js"
        | "curl"
        | "gh"
        | "gogcli";
      name?: string;
      description?: string;
      input_schema?: Record<string, unknown>;
      js_source?: string;
    }>;
  };
}

interface DefinitionOutput {
  from?: string;
  deliver?: Array<{
    type?: string;
    url?: string;
    method?: string;
    signing_secret_name?: string;
  }>;
}

interface OutboundWebhookConfig {
  enabled: boolean;
  from: string;
  url: string;
  method: "POST" | "PUT" | "GET";
  signingSecretName: string;
}

interface ModelOption {
  id: string;
  name: string;
}

type RunInputFieldType = "string" | "integer" | "number" | "boolean";

interface RunInputField {
  name: string;
  type: RunInputFieldType;
  required: boolean;
  description?: string;
  defaultValue?: unknown;
  source: "schema" | "inferred";
}

interface RunInputIssue {
  field: string;
  message: string;
}

type StepSectionKey = "prompt" | "runtime" | "tools";

interface StepSectionState {
  prompt: boolean;
  runtime: boolean;
  tools: boolean;
}

const DEFAULT_STEP_SECTIONS: StepSectionState = {
  prompt: true,
  runtime: false,
  tools: false,
};

function isRunInputFieldType(value: unknown): value is RunInputFieldType {
  return (
    value === "string" ||
    value === "integer" ||
    value === "number" ||
    value === "boolean"
  );
}

function extractPromptInputRefs(prompt: string): string[] {
  const refs = new Set<string>();
  const matches = prompt.matchAll(/\{\{\s*input\.([a-zA-Z0-9_.]+)\s*\}\}/g);
  for (const match of matches) {
    const field = (match[1] || "").trim();
    if (field) refs.add(field);
  }
  return Array.from(refs);
}

function buildRunInputFields(
  definition: unknown,
  steps: StepDef[],
): RunInputField[] {
  const fields = new Map<string, RunInputField>();
  const schema = (
    definition &&
    typeof definition === "object" &&
    "input" in definition &&
    (definition as { input?: { schema?: Record<string, unknown> } }).input
      ?.schema
  )
    ? (
        definition as {
          input: { schema: Record<string, unknown> };
        }
      ).input.schema
    : {};

  for (const [name, rawVariable] of Object.entries(schema)) {
    if (!rawVariable || typeof rawVariable !== "object") continue;
    const variable = rawVariable as {
      type?: unknown;
      required?: unknown;
      description?: unknown;
      default?: unknown;
    };
    if (!isRunInputFieldType(variable.type)) continue;

    fields.set(name, {
      name,
      type: variable.type,
      required: Boolean(variable.required),
      description:
        typeof variable.description === "string" ? variable.description : "",
      defaultValue: variable.default,
      source: "schema",
    });
  }

  for (const step of steps) {
    for (const ref of extractPromptInputRefs(step.prompt || "")) {
      if (fields.has(ref)) continue;
      fields.set(ref, {
        name: ref,
        type: "string",
        required: true,
        source: "inferred",
      });
    }
  }

  return Array.from(fields.values()).sort((a, b) => a.name.localeCompare(b.name));
}

type RunInputDraft = Record<string, string | boolean>;

function runInputStorageKey(pipelineId: string): string {
  return `pipeline-run-inputs:${pipelineId}`;
}

function readSavedRunInputPayload(
  pipelineId: string,
): Record<string, unknown> | null {
  if (!pipelineId || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(runInputStorageKey(pipelineId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function saveRunInputPayload(
  pipelineId: string,
  payload: Record<string, unknown>,
): void {
  if (!pipelineId || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      runInputStorageKey(pipelineId),
      JSON.stringify(payload),
    );
  } catch {
    // Ignore storage quota/private mode errors.
  }
}

function fieldDefaultToDraftValue(field: RunInputField): string | boolean {
  if (field.defaultValue === undefined || field.defaultValue === null) {
    return field.type === "boolean" ? false : "";
  }
  if (field.type === "boolean") {
    return Boolean(field.defaultValue);
  }
  if (field.type === "integer" || field.type === "number") {
    return String(field.defaultValue);
  }
  return String(field.defaultValue);
}

function parseRunInputPayload(fields: RunInputField[], draft: RunInputDraft): {
  payload: Record<string, unknown>;
  issues: RunInputIssue[];
} {
  const payload: Record<string, unknown> = {};
  const issues: RunInputIssue[] = [];

  for (const field of fields) {
    const hasDraftValue = Object.prototype.hasOwnProperty.call(draft, field.name);
    const raw = hasDraftValue ? draft[field.name] : field.defaultValue;

    if (field.type === "boolean") {
      if (raw === undefined || raw === null) {
        if (field.required) {
          issues.push({
            field: field.name,
            message: `Field "${field.name}" is required`,
          });
        }
        continue;
      }
      if (typeof raw === "boolean") {
        payload[field.name] = raw;
        continue;
      }
      if (typeof raw === "string") {
        if (raw === "true") {
          payload[field.name] = true;
          continue;
        }
        if (raw === "false") {
          payload[field.name] = false;
          continue;
        }
      }
      issues.push({
        field: field.name,
        message: `Field "${field.name}" must be of type boolean`,
      });
      continue;
    }

    if (raw === undefined || raw === null || raw === "") {
      if (field.required) {
        issues.push({
          field: field.name,
          message: `Field "${field.name}" is required`,
        });
      }
      continue;
    }

    if (field.type === "string") {
      const value = String(raw);
      if (field.required && value.trim().length === 0) {
        issues.push({
          field: field.name,
          message: `Field "${field.name}" is required`,
        });
        continue;
      }
      payload[field.name] = value;
      continue;
    }

    const numeric = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(numeric)) {
      issues.push({
        field: field.name,
        message: `Field "${field.name}" must be of type ${field.type}`,
      });
      continue;
    }
    if (field.type === "integer" && !Number.isInteger(numeric)) {
      issues.push({
        field: field.name,
        message: `Field "${field.name}" must be of type integer`,
      });
      continue;
    }
    payload[field.name] = numeric;
  }

  return { payload, issues };
}

function runInputPayloadToDraft(
  fields: RunInputField[],
  payload: Record<string, unknown>,
): RunInputDraft {
  const draft: RunInputDraft = {};
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(payload, field.name)) continue;
    const value = payload[field.name];
    if (field.type === "boolean") {
      draft[field.name] = Boolean(value);
      continue;
    }
    if (value === undefined || value === null) continue;
    draft[field.name] = String(value);
  }
  return draft;
}

function getPromptTemplateWarning(
  prompt: string,
  stepIds: string[],
): string | null {
  const openCount = (prompt.match(/\{\{/g) || []).length;
  const closeCount = (prompt.match(/\}\}/g) || []).length;
  if (openCount !== closeCount) {
    return "Unbalanced Handlebars braces. Check {{ and }}.";
  }

  const refs = [
    ...prompt.matchAll(/\{\{\s*steps\.([a-zA-Z0-9_]+)\.output\s*\}\}/g),
  ];
  for (const ref of refs) {
    const key = ref[1] || "";
    if (!key) continue;
    const isNumeric = /^\d+$/.test(key);
    if (!isNumeric && !stepIds.includes(key)) {
      return `Unknown step reference "${key}". Use an existing step id or a numeric alias.`;
    }
  }

  return null;
}

function newStep(index: number): StepDef {
  return {
    id: `step_${index}`,
    name: `Step ${index}`,
    type: "llm",
    model: "gpt-5.2",
    prompt: "",
    outputFormat: "text",
    timeout: 30,
    retries: 2,
    agentMaxTurns: 8,
    agentMaxDurationSeconds: 45,
    agentMaxToolCalls: 3,
    networkAllowlist: "",
    tools: [],
  };
}

function normalizeOutboundWebhook(
  definition: unknown,
): OutboundWebhookConfig | null {
  if (!definition || typeof definition !== "object") return null;
  const output = (definition as { output?: DefinitionOutput }).output;
  if (!output || typeof output !== "object") return null;

  const delivery = (output.deliver || []).find((d) => d.type === "webhook");
  if (!delivery) return null;

  const method =
    delivery.method === "PUT" || delivery.method === "GET"
      ? delivery.method
      : "POST";

  return {
    enabled: true,
    from: output.from || "",
    url: delivery.url || "",
    method,
    signingSecretName: delivery.signing_secret_name || "",
  };
}

function areOutboundWebhookConfigsEqual(
  current: OutboundWebhookConfig,
  persisted: OutboundWebhookConfig | null,
): boolean {
  if (!persisted) return !current.enabled;
  if (!current.enabled) return false;
  return (
    current.from === persisted.from &&
    current.url.trim() === persisted.url.trim() &&
    current.method === persisted.method &&
    current.signingSecretName.trim() === persisted.signingSecretName.trim()
  );
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function CodeSourceEditor({
  value,
  onChange,
  placeholder,
  language,
  minRows = 8,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  language: "javascript" | "json";
  minRows?: number;
}) {
  const highlightRef = useRef<HTMLPreElement | null>(null);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const lineCount = Math.max(minRows, value.split("\n").length + 1);
  const hasContent = value.trim().length > 0;
  const highlighted = (() => {
    const source = hasContent ? value : placeholder;
    try {
      const grammar =
        language === "json"
          ? Prism.languages.json
          : Prism.languages.javascript;
      return Prism.highlight(
        source,
        grammar,
        language,
      );
    } catch {
      return escapeHtml(source);
    }
  })();

  const syncScroll = () => {
    const pre = highlightRef.current;
    const textarea = textAreaRef.current;
    if (!pre || !textarea) return;
    pre.scrollTop = textarea.scrollTop;
    pre.scrollLeft = textarea.scrollLeft;
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Tab") return;

    e.preventDefault();
    const textarea = textAreaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const indent = "  ";

    if (e.shiftKey) {
      const lineStart = value.lastIndexOf("\n", start - 1) + 1;
      const block = value.slice(lineStart, end);
      const outdented = block.replace(/^( {1,2}|\t)/gm, "");
      const next = value.slice(0, lineStart) + outdented + value.slice(end);
      onChange(next);
      requestAnimationFrame(() => {
        const removedChars = block.length - outdented.length;
        textarea.setSelectionRange(
          Math.max(lineStart, start - 2),
          Math.max(lineStart, end - removedChars),
        );
      });
      return;
    }

    if (start !== end) {
      const lineStart = value.lastIndexOf("\n", start - 1) + 1;
      const block = value.slice(lineStart, end);
      const indented = block.replace(/^/gm, indent);
      const next = value.slice(0, lineStart) + indented + value.slice(end);
      onChange(next);
      requestAnimationFrame(() => {
        const addedChars = indented.length - block.length;
        textarea.setSelectionRange(start + indent.length, end + addedChars);
      });
      return;
    }

    const next = `${value.slice(0, start)}${indent}${value.slice(end)}`;
    onChange(next);
    requestAnimationFrame(() => {
      const cursor = start + indent.length;
      textarea.setSelectionRange(cursor, cursor);
    });
  };

  return (
    <div className="js-source-editor relative mt-1 rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)]">
      <pre
        ref={highlightRef}
        aria-hidden="true"
        className={`pointer-events-none m-0 whitespace-pre-wrap break-words px-2 py-2 text-xs leading-relaxed ${
          hasContent ? "" : "text-[var(--text-tertiary)]"
        }`}
        style={{ fontFamily: "var(--font-mono)" }}
      >
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: Prism generates local syntax markup from editor text. */}
        <code dangerouslySetInnerHTML={{ __html: highlighted }} />
      </pre>
      <textarea
        ref={textAreaRef}
        className="absolute inset-0 m-0 w-full resize-none overflow-auto bg-transparent px-2 py-2 text-xs leading-relaxed text-transparent caret-[var(--text-primary)] focus:outline-none"
        style={{ fontFamily: "var(--font-mono)" }}
        rows={lineCount}
        value={value}
        onScroll={syncScroll}
        onKeyDown={handleKeyDown}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

export function PipelineEditorPage() {
  const { pipelineId } = useParams({ strict: false }) as { pipelineId: string };
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const pipelineQ = useQuery({
    queryKey: ["pipeline", pipelineId],
    queryFn: () => apiFetch<PipelineRecord>(`/api/pipelines/${pipelineId}`),
    enabled: Boolean(pipelineId),
  });

  const modelsQ = useQuery({
    queryKey: ["models"],
    queryFn: () => apiFetch<ModelOption[]>("/api/models", undefined, false),
  });

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [steps, setSteps] = useState<StepDef[]>([]);
  const [outputFromStepId, setOutputFromStepId] = useState("");
  const [outputWebhookEnabled, setOutputWebhookEnabled] = useState(false);
  const [outputWebhookUrl, setOutputWebhookUrl] = useState("");
  const [outputWebhookMethod, setOutputWebhookMethod] = useState<
    "POST" | "PUT" | "GET"
  >("POST");
  const [outputWebhookSigningSecret, setOutputWebhookSigningSecret] =
    useState("");
  const [variables, setVariables] = useState<{ key: string; value: string }[]>(
    [],
  );
  const [expandedStep, setExpandedStep] = useState<number>(0);
  const [message, setMessage] = useState<string | null>(null);
  const [pipelineSecretName, setPipelineSecretName] = useState("");
  const [pipelineSecretValue, setPipelineSecretValue] = useState("");
  const [pipelineSecretUpdateName, setPipelineSecretUpdateName] = useState<
    string | null
  >(null);
  const [pipelineSecretUpdateValue, setPipelineSecretUpdateValue] =
    useState("");
  const [pipelineSecretError, setPipelineSecretError] = useState<string | null>(
    null,
  );
  const [pipelineSecretSuccess, setPipelineSecretSuccess] = useState<
    string | null
  >(null);
  const [yamlMode, setYamlMode] = useState(false);
  const [rawYaml, setRawYaml] = useState("");
  const [selectedPrevStepToken, setSelectedPrevStepToken] = useState<
    Record<number, string>
  >({});
  const [expandedStepSections, setExpandedStepSections] = useState<
    Record<number, StepSectionState>
  >({});
  const [expandedToolEditors, setExpandedToolEditors] = useState<
    Record<string, boolean>
  >({});
  const [runInputModalOpen, setRunInputModalOpen] = useState(false);
  const [runInputDraft, setRunInputDraft] = useState<RunInputDraft>({});
  const [runInputIssues, setRunInputIssues] = useState<RunInputIssue[]>([]);
  const promptRefs = useRef<Record<number, HTMLTextAreaElement | null>>({});

  const modelOptions = (() => {
    const fromApi = (modelsQ.data ?? []).map((model) => ({
      id: model.id,
      label: `${model.name} (${model.id})`,
    }));
    const fromSteps = steps
      .map((step) => step.model)
      .filter(Boolean)
      .map((id) => ({ id, label: id }));
    const merged = [...fromApi, ...fromSteps];
    return merged.filter(
      (item, index) => merged.findIndex((x) => x.id === item.id) === index,
    );
  })();

  const runInputFields = useMemo(
    () => buildRunInputFields(pipelineQ.data?.definition, steps),
    [pipelineQ.data?.definition, steps],
  );

  useEffect(() => {
    if (!pipelineId || runInputFields.length === 0) return;
    const savedPayload = readSavedRunInputPayload(pipelineId);
    if (!savedPayload) return;
    const savedDraft = runInputPayloadToDraft(runInputFields, savedPayload);
    if (Object.keys(savedDraft).length === 0) return;
    setRunInputDraft((prev) => ({ ...savedDraft, ...prev }));
  }, [pipelineId, runInputFields]);

  const pipelineSecretsQ = useQuery({
    queryKey: ["pipeline-secrets", pipelineId],
    queryFn: () =>
      apiFetch<SecretRecord[]>(`/api/pipelines/${pipelineId}/secrets`),
    enabled: Boolean(pipelineId),
  });

  // Load pipeline data
  useEffect(() => {
    if (!pipelineQ.data) return;
    const p = pipelineQ.data;
    setName(p.name);
    setDescription(p.description || "");
    const def = (p.definition ?? {}) as {
      steps?: DefinitionStep[];
      variables?: Record<string, string>;
      output?: DefinitionOutput;
    };
    setSteps(
      (def.steps ?? []).map((s, i) => ({
        id: s.id || `step_${i + 1}`,
        name: s.name || `Step ${i + 1}`,
        type: s.type || "llm",
        model: s.model || "gpt-5.2",
        prompt: s.prompt || "",
        outputFormat: s.output_format || s.outputFormat || "text",
        timeout: s.timeout_seconds ?? s.timeout ?? 30,
        retries: s.retry?.max_attempts ?? s.retries ?? 2,
        agentMaxTurns: s.agent?.max_turns ?? 8,
        agentMaxDurationSeconds: s.agent?.max_duration_seconds ?? 45,
        agentMaxToolCalls: s.agent?.max_tool_calls ?? 3,
        networkAllowlist: (s.agent?.network_allowlist || []).join(", "),
        tools: (s.agent?.tools || []).map((tool) => ({
          type: tool.type || "http_request",
          name: tool.name || "",
          description: tool.description || "",
          inputSchema: tool.input_schema
            ? JSON.stringify(tool.input_schema, null, 2)
            : "",
          jsSource: tool.js_source || "",
        })),
      })),
    );
    const vars = def.variables ?? {};
    setVariables(
      Object.entries(vars).map(([key, value]) => ({
        key,
        value: String(value),
      })),
    );
    const fallbackFrom =
      (def.steps ?? []).at((def.steps ?? []).length - 1)?.id || "";
    const from = def.output?.from || fallbackFrom;
    const outboundWebhook = (def.output?.deliver || []).find(
      (d) => d.type === "webhook",
    );
    setOutputFromStepId(from);
    setOutputWebhookEnabled(Boolean(outboundWebhook));
    setOutputWebhookUrl(outboundWebhook?.url || "");
    setOutputWebhookMethod(
      outboundWebhook?.method === "PUT" || outboundWebhook?.method === "GET"
        ? outboundWebhook.method
        : "POST",
    );
    setOutputWebhookSigningSecret(outboundWebhook?.signing_secret_name || "");
    setRawYaml(YAML.stringify(p.definition ?? {}));
    setExpandedStepSections({});
    setExpandedToolEditors({});
    setRunInputModalOpen(false);
    setRunInputDraft({});
    setRunInputIssues([]);
  }, [pipelineQ.data]);

  // Build definition from structured state
  const buildDefinition = useCallback(() => {
    if (yamlMode) {
      try {
        return YAML.parse(rawYaml);
      } catch {
        return {};
      }
    }
    const vars: Record<string, string> = {};
    for (const v of variables) {
      if (v.key) vars[v.key] = v.value;
    }
    return {
      name,
      version: pipelineQ.data?.version ?? 1,
      steps: steps.map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type,
        model: s.model,
        prompt: s.prompt,
        output_format: s.outputFormat,
        timeout_seconds: s.timeout,
        retry: {
          max_attempts: s.retries ?? 1,
          backoff_ms: 1000,
        },
        agent: {
          max_turns: s.agentMaxTurns,
          max_duration_seconds: s.agentMaxDurationSeconds,
          max_tool_calls: s.agentMaxToolCalls,
          network_allowlist: (s.networkAllowlist || "")
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean),
          tools: (s.tools || [])
            .filter((tool) => tool.name.trim().length > 0)
            .map((tool) => ({
              type: tool.type,
              name: tool.name.trim(),
              description: tool.description?.trim() || undefined,
              input_schema: tool.inputSchema?.trim()
                ? (() => {
                    try {
                      return JSON.parse(tool.inputSchema || "{}");
                    } catch {
                      return {};
                    }
                  })()
                : undefined,
              js_source: tool.jsSource?.trim() || undefined,
            })),
        },
      })),
      variables: Object.keys(vars).length > 0 ? vars : undefined,
      output: {
        from: outputFromStepId || steps[steps.length - 1]?.id || "",
        deliver: outputWebhookEnabled
          ? [
              {
                type: "webhook",
                url: outputWebhookUrl,
                method: outputWebhookMethod,
                signing_secret_name: outputWebhookSigningSecret || undefined,
              },
            ]
          : undefined,
      },
    };
  }, [
    yamlMode,
    rawYaml,
    name,
    steps,
    variables,
    outputFromStepId,
    outputWebhookEnabled,
    outputWebhookUrl,
    outputWebhookMethod,
    outputWebhookSigningSecret,
    pipelineQ.data,
  ]);

  // Sync rawYaml when switching to YAML mode
  useEffect(() => {
    if (yamlMode) setRawYaml(YAML.stringify(buildDefinition()));
    // eslint-disable-next-line
  }, [yamlMode, buildDefinition]);

  // Step mutations
  const updateStep = (idx: number, patch: Partial<StepDef>) => {
    setSteps((prev) =>
      prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)),
    );
  };

  const sectionStateFor = (idx: number): StepSectionState =>
    expandedStepSections[idx] || DEFAULT_STEP_SECTIONS;

  const toggleStepSection = (idx: number, section: StepSectionKey) => {
    setExpandedStepSections((prev) => {
      const current = prev[idx] || DEFAULT_STEP_SECTIONS;
      return {
        ...prev,
        [idx]: {
          ...current,
          [section]: !current[section],
        },
      };
    });
  };

  const toolKey = (stepIdx: number, toolIdx: number) => `${stepIdx}:${toolIdx}`;
  const isToolExpanded = (stepIdx: number, toolIdx: number) =>
    Boolean(expandedToolEditors[toolKey(stepIdx, toolIdx)]);

  const toggleToolExpanded = (stepIdx: number, toolIdx: number) => {
    const key = toolKey(stepIdx, toolIdx);
    setExpandedToolEditors((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const addTool = (idx: number) => {
    const nextToolIndex = (steps[idx]?.tools || []).length;
    setSteps((prev) =>
      prev.map((step, i) =>
        i === idx
          ? {
              ...step,
              tools: [
                ...(step.tools || []),
                {
                  type: "http_request",
                  name: "",
                  description: "",
                  inputSchema: "",
                  jsSource: "",
                },
              ],
            }
          : step,
      ),
    );
    setExpandedStepSections((prev) => ({
      ...prev,
      [idx]: {
        ...(prev[idx] || DEFAULT_STEP_SECTIONS),
        tools: true,
      },
    }));
    setExpandedToolEditors((prev) => ({
      ...prev,
      [toolKey(idx, nextToolIndex)]: true,
    }));
  };

  const updateTool = (
    stepIdx: number,
    toolIdx: number,
    patch: Partial<StepToolDef>,
  ) => {
    setSteps((prev) =>
      prev.map((step, i) =>
        i !== stepIdx
          ? step
          : {
              ...step,
              tools: (step.tools || []).map((tool, j) =>
                j === toolIdx ? { ...tool, ...patch } : tool,
              ),
            },
      ),
    );
  };

  const removeTool = (stepIdx: number, toolIdx: number) => {
    setSteps((prev) =>
      prev.map((step, i) =>
        i !== stepIdx
          ? step
          : {
              ...step,
              tools: (step.tools || []).filter((_, j) => j !== toolIdx),
            },
      ),
    );
    setExpandedToolEditors((prev) => {
      const next: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(prev)) {
        if (!key.startsWith(`${stepIdx}:`)) {
          next[key] = value;
          continue;
        }
        const index = Number(key.split(":")[1]);
        if (Number.isNaN(index) || index === toolIdx) continue;
        const nextIndex = index > toolIdx ? index - 1 : index;
        next[toolKey(stepIdx, nextIndex)] = value;
      }
      return next;
    });
  };

  const removeStep = (idx: number) => {
    setSteps((prev) => prev.filter((_, i) => i !== idx));
    setExpandedStepSections((prev) => {
      const next: Record<number, StepSectionState> = {};
      for (const [key, value] of Object.entries(prev)) {
        const index = Number(key);
        if (Number.isNaN(index) || index === idx) continue;
        next[index > idx ? index - 1 : index] = value;
      }
      return next;
    });
    setExpandedToolEditors((prev) => {
      const next: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(prev)) {
        const [stepIndexRaw, toolIndexRaw] = key.split(":");
        const stepIndex = Number(stepIndexRaw);
        const toolIndex = Number(toolIndexRaw);
        if (Number.isNaN(stepIndex) || Number.isNaN(toolIndex)) continue;
        if (stepIndex === idx) continue;
        const nextStepIndex = stepIndex > idx ? stepIndex - 1 : stepIndex;
        next[toolKey(nextStepIndex, toolIndex)] = value;
      }
      return next;
    });
    if (expandedStep >= idx && expandedStep > 0)
      setExpandedStep(expandedStep - 1);
  };

  const addStep = () => {
    const next = steps.length + 1;
    setSteps((prev) => [...prev, newStep(next)]);
    setExpandedStepSections((prev) => ({
      ...prev,
      [steps.length]: DEFAULT_STEP_SECTIONS,
    }));
    setExpandedStep(steps.length);
  };

  const moveStep = (idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= steps.length) return;
    setSteps((prev) => {
      const copy = [...prev];
      [copy[idx], copy[target]] = [copy[target], copy[idx]];
      return copy;
    });
    setExpandedStepSections((prev) => {
      const next = { ...prev };
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
    setExpandedToolEditors((prev) => {
      const next: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(prev)) {
        const [stepIndexRaw, toolIndexRaw] = key.split(":");
        const stepIndex = Number(stepIndexRaw);
        const toolIndex = Number(toolIndexRaw);
        if (Number.isNaN(stepIndex) || Number.isNaN(toolIndex)) continue;
        if (stepIndex === idx) {
          next[toolKey(target, toolIndex)] = value;
        } else if (stepIndex === target) {
          next[toolKey(idx, toolIndex)] = value;
        } else {
          next[key] = value;
        }
      }
      return next;
    });
    setExpandedStep(target);
  };

  const insertPromptToken = (idx: number, token: string) => {
    const target = promptRefs.current[idx];
    if (!target) {
      const current = steps[idx]?.prompt || "";
      updateStep(idx, { prompt: `${current}${current ? " " : ""}${token}` });
      return;
    }
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? target.value.length;
    const next = target.value.slice(0, start) + token + target.value.slice(end);
    updateStep(idx, { prompt: next });

    requestAnimationFrame(() => {
      const node = promptRefs.current[idx];
      if (!node) return;
      const pos = start + token.length;
      node.focus();
      node.setSelectionRange(pos, pos);
    });
  };

  // Variable mutations
  const updateVar = (idx: number, field: "key" | "value", val: string) => {
    setVariables((prev) =>
      prev.map((v, i) => (i === idx ? { ...v, [field]: val } : v)),
    );
  };
  const removeVar = (idx: number) =>
    setVariables((prev) => prev.filter((_, i) => i !== idx));
  const addVar = () =>
    setVariables((prev) => [...prev, { key: "", value: "" }]);

  // Save
  const saveMut = useMutation({
    mutationFn: async () => {
      const definition = buildDefinition();
      return apiFetch<PipelineRecord>(`/api/pipelines/${pipelineId}`, {
        method: "PUT",
        body: JSON.stringify({ name, description, definition }),
      });
    },
    onSuccess: async () => {
      trackPipelineSaved(pipelineId, steps.length);
      const local = {
        enabled: outputWebhookEnabled,
        from: outputFromStepId || steps[steps.length - 1]?.id || "",
        url: outputWebhookUrl,
        method: outputWebhookMethod,
        signingSecretName: outputWebhookSigningSecret,
      } satisfies OutboundWebhookConfig;

      const persisted = await queryClient.fetchQuery({
        queryKey: ["pipeline", pipelineId],
        queryFn: () => apiFetch<PipelineRecord>(`/api/pipelines/${pipelineId}`),
      });

      const persistedWebhook = normalizeOutboundWebhook(persisted.definition);
      const matches = areOutboundWebhookConfigsEqual(local, persistedWebhook);
      if (matches) {
        setMessage("Pipeline saved ✓");
      } else {
        setMessage(
          "Pipeline saved, but outbound webhook config was not persisted exactly as entered. Please review and save again.",
        );
      }
    },
    onError: (err) =>
      setMessage(err instanceof Error ? err.message : "Save failed"),
  });

  // Run
  const runMut = useMutation({
    mutationFn: (payload?: { input_data?: Record<string, unknown> }) =>
      apiFetch<RunRecord>(`/api/pipelines/${pipelineId}/run`, {
        method: "POST",
        body: JSON.stringify(payload || {}),
      }),
    onSuccess: (run) => {
      trackPipelineRunTriggered(pipelineId, "manual");
      navigate({ to: "/runs/$runId", params: { runId: run.id } });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 422) {
        const details = err.details as
          | { issues?: Array<{ field?: string; message?: string }> }
          | undefined;
        const issues = (details?.issues || [])
          .map((issue) => ({
            field: issue.field || "input",
            message: issue.message || "Invalid input value",
          }))
          .filter((issue) => issue.message);
        if (issues.length > 0) {
          setRunInputIssues(issues);
          setRunInputModalOpen(true);
          return;
        }
      }
      setMessage(err instanceof Error ? err.message : "Run failed");
    },
  });

  const openRunInputModal = () => {
    setRunInputIssues([]);
    setRunInputDraft((prev) => {
      const next = { ...prev };
      for (const field of runInputFields) {
        if (Object.prototype.hasOwnProperty.call(next, field.name)) continue;
        if (field.defaultValue !== undefined || field.type === "boolean") {
          next[field.name] = fieldDefaultToDraftValue(field);
        }
      }
      return next;
    });
    setRunInputModalOpen(true);
  };

  const submitRunWithInputs = () => {
    const parsed = parseRunInputPayload(runInputFields, runInputDraft);
    if (parsed.issues.length > 0) {
      setRunInputIssues(parsed.issues);
      return;
    }
    setRunInputIssues([]);
    setMessage(null);
    saveRunInputPayload(pipelineId, parsed.payload);
    runMut.mutate({ input_data: parsed.payload });
  };

  const handleTestRun = () => {
    setMessage(null);
    if (runInputFields.length === 0) {
      saveRunInputPayload(pipelineId, {});
      runMut.mutate({ input_data: {} });
      return;
    }
    openRunInputModal();
  };

  const createPipelineSecretMut = useMutation({
    mutationFn: (payload: { name: string; value: string }) =>
      apiFetch<SecretRecord>(`/api/pipelines/${pipelineId}/secrets`, {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      trackSecretCreated("pipeline");
      setPipelineSecretName("");
      setPipelineSecretValue("");
      setPipelineSecretError(null);
      setPipelineSecretSuccess("Pipeline secret saved");
      queryClient.invalidateQueries({
        queryKey: ["pipeline-secrets", pipelineId],
      });
    },
    onError: (err) => {
      setPipelineSecretSuccess(null);
      setPipelineSecretError(
        err instanceof ApiError ? err.message : "Failed to create secret",
      );
    },
  });

  const updatePipelineSecretMut = useMutation({
    mutationFn: (payload: { name: string; value: string }) =>
      apiFetch<SecretRecord>(
        `/api/pipelines/${pipelineId}/secrets/${encodeURIComponent(payload.name)}`,
        {
          method: "PUT",
          body: JSON.stringify({ value: payload.value }),
        },
      ),
    onSuccess: (_, payload) => {
      trackSecretUpdated("pipeline");
      setPipelineSecretUpdateName(null);
      setPipelineSecretUpdateValue("");
      setPipelineSecretError(null);
      setPipelineSecretSuccess(`Secret "${payload.name}" updated`);
      queryClient.invalidateQueries({
        queryKey: ["pipeline-secrets", pipelineId],
      });
    },
    onError: (err) => {
      setPipelineSecretSuccess(null);
      setPipelineSecretError(
        err instanceof ApiError ? err.message : "Failed to update secret",
      );
    },
  });

  const deletePipelineSecretMut = useMutation({
    mutationFn: (name: string) =>
      apiFetch<{ deleted: boolean }>(
        `/api/pipelines/${pipelineId}/secrets/${encodeURIComponent(name)}`,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      trackSecretDeleted("pipeline");
      setPipelineSecretError(null);
      setPipelineSecretSuccess("Secret removed");
      queryClient.invalidateQueries({
        queryKey: ["pipeline-secrets", pipelineId],
      });
    },
    onError: (err) => {
      setPipelineSecretSuccess(null);
      setPipelineSecretError(
        err instanceof ApiError ? err.message : "Failed to delete secret",
      );
    },
  });

  const submitPipelineSecret = () => {
    setPipelineSecretSuccess(null);
    const normalizedName = pipelineSecretName.trim().toUpperCase();
    if (!normalizedName || !pipelineSecretValue.trim()) {
      setPipelineSecretError("Name and value are required");
      return;
    }
    createPipelineSecretMut.mutate({
      name: normalizedName,
      value: pipelineSecretValue,
    });
  };

  const submitPipelineSecretUpdate = () => {
    if (!pipelineSecretUpdateName || !pipelineSecretUpdateValue.trim()) {
      setPipelineSecretError("New secret value is required");
      return;
    }
    setPipelineSecretSuccess(null);
    updatePipelineSecretMut.mutate({
      name: pipelineSecretUpdateName,
      value: pipelineSecretUpdateValue,
    });
  };

  const status = pipelineQ.data?.status || "draft";

  const actions = (
    <div className="flex items-center gap-3">
      <StatusBadge status={status} />
      <button
        type="button"
        className="rounded-lg border border-[var(--text-muted)] px-[18px] py-2.5 text-sm font-medium text-[var(--text-secondary)]"
        onClick={handleTestRun}
        disabled={runMut.isPending}
      >
        ▷ Test Run
      </button>
      <button
        type="button"
        className="rounded-lg bg-[var(--accent)] px-[18px] py-2.5 text-sm font-semibold text-[var(--bg-primary)]"
        onClick={() => saveMut.mutate()}
      >
        Save Pipeline
      </button>
    </div>
  );

  return (
    <AppShell
      title={name || "Pipeline Editor"}
      subtitle={description || "Configure your pipeline steps and variables"}
      actions={actions}
    >
      {pipelineQ.isLoading ? (
        <p className="text-sm text-[var(--text-tertiary)]">
          Loading pipeline...
        </p>
      ) : null}
      {pipelineQ.isError ? (
        <p className="text-sm text-red-300">
          {pipelineQ.error instanceof Error
            ? pipelineQ.error.message
            : "Failed to load"}
        </p>
      ) : null}
      {message ? (
        <p className="mb-2 text-sm text-[var(--text-secondary)]">{message}</p>
      ) : null}
      {runInputModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-2xl rounded-xl border border-[var(--divider)] bg-[var(--bg-surface)] p-5">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">Provide Run Inputs</h2>
                <p className="text-sm text-[var(--text-tertiary)]">
                  These values will be sent as <code>input_data</code> for this
                  test run.
                </p>
              </div>
              <button
                type="button"
                className="rounded-md px-2 py-1 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-inset)]"
                onClick={() => {
                  setRunInputModalOpen(false);
                  setRunInputIssues([]);
                }}
              >
                Close
              </button>
            </div>

            <div className="max-h-[60vh] space-y-3 overflow-auto pr-1">
              {runInputFields.map((field) => {
                const hasDraft = Object.prototype.hasOwnProperty.call(
                  runInputDraft,
                  field.name,
                );
                const rawValue = hasDraft
                  ? runInputDraft[field.name]
                  : field.defaultValue;
                const value =
                  rawValue === undefined || rawValue === null
                    ? ""
                    : String(rawValue);

                return (
                  <div
                    key={field.name}
                    className="flex flex-col gap-1 rounded-lg border border-[var(--divider)] bg-[var(--bg-inset)] p-3"
                  >
                    <span className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
                      <span>{field.name}</span>
                      {field.required ? (
                        <span className="rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] uppercase text-red-300">
                          required
                        </span>
                      ) : (
                        <span className="rounded bg-[var(--bg-surface)] px-1.5 py-0.5 text-[10px] uppercase text-[var(--text-muted)]">
                          optional
                        </span>
                      )}
                      <span className="rounded bg-[var(--bg-surface)] px-1.5 py-0.5 text-[10px] uppercase text-[var(--text-muted)]">
                        {field.type}
                      </span>
                      {field.source === "inferred" ? (
                        <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] uppercase text-amber-200">
                          inferred
                        </span>
                      ) : null}
                    </span>
                    {field.description ? (
                      <span className="text-xs text-[var(--text-tertiary)]">
                        {field.description}
                      </span>
                    ) : null}
                    {field.type === "boolean" ? (
                      <input
                        type="checkbox"
                        aria-label={field.name}
                        checked={Boolean(
                          hasDraft ? runInputDraft[field.name] : rawValue,
                        )}
                        onChange={(e) => {
                          setRunInputIssues([]);
                          setRunInputDraft((prev) => ({
                            ...prev,
                            [field.name]: e.target.checked,
                          }));
                        }}
                        className="h-4 w-4 rounded border-[var(--divider)] bg-[var(--bg-surface)] accent-[var(--accent)]"
                      />
                    ) : (
                      <input
                        aria-label={field.name}
                        type={
                          field.type === "integer" || field.type === "number"
                            ? "number"
                            : "text"
                        }
                        step={field.type === "integer" ? "1" : "any"}
                        value={value}
                        onChange={(e) => {
                          setRunInputIssues([]);
                          setRunInputDraft((prev) => ({
                            ...prev,
                            [field.name]: e.target.value,
                          }));
                        }}
                        placeholder={
                          field.defaultValue !== undefined
                            ? String(field.defaultValue)
                            : ""
                        }
                        className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-surface)] px-2 py-2 text-sm focus:border-[var(--accent)] focus:outline-none"
                      />
                    )}
                  </div>
                );
              })}
            </div>

            {runInputIssues.length > 0 ? (
              <div className="mt-3 rounded border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-200">
                {runInputIssues.map((issue, index) => (
                  <p key={`${issue.field}-${index}`}>{issue.message}</p>
                ))}
              </div>
            ) : null}

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setRunInputModalOpen(false);
                  setRunInputIssues([]);
                }}
                className="rounded-lg border border-[var(--divider)] px-4 py-2 text-sm text-[var(--text-secondary)]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitRunWithInputs}
                disabled={runMut.isPending}
                className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--bg-primary)] disabled:opacity-70"
              >
                {runMut.isPending ? "Running..." : "Run Pipeline"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-6 lg:flex-row">
        {/* Left panel — 360px on desktop, full width on mobile */}
        <div className="flex w-full shrink-0 flex-col gap-5 lg:w-[360px]">
          {/* Config card */}
          <div className="flex flex-col gap-4 rounded-[10px] border border-[var(--divider)] bg-[var(--bg-surface)] p-5">
            <h2 className="text-[15px] font-semibold">Pipeline Config</h2>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-[var(--text-secondary)]">
                Name
              </span>
              <input
                className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3.5 py-2.5 text-[13px] focus:border-[var(--accent)] focus:outline-none"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-[var(--text-secondary)]">
                Description
              </span>
              <input
                className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3.5 py-2.5 text-[13px] focus:border-[var(--accent)] focus:outline-none"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
          </div>

          {/* Variables card */}
          <div className="flex flex-col gap-4 rounded-[10px] border border-[var(--divider)] bg-[var(--bg-surface)] p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-[15px] font-semibold">Variables</h2>
              <button
                type="button"
                onClick={addVar}
                className="text-xs font-medium text-[var(--accent)]"
              >
                + Add
              </button>
            </div>
            <div className="flex flex-col gap-2">
              {variables.map((v, i) => (
                <div
                  key={`var-${v.key || i}`}
                  className="flex items-center gap-2"
                >
                  <input
                    className="min-w-0 flex-1 rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3 py-2 text-xs focus:border-[var(--accent)] focus:outline-none"
                    style={{ fontFamily: "var(--font-mono)" }}
                    value={v.key}
                    onChange={(e) => updateVar(i, "key", e.target.value)}
                    placeholder="key"
                  />
                  <input
                    className="min-w-0 flex-1 rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3 py-2 text-xs focus:border-[var(--accent)] focus:outline-none"
                    style={{ fontFamily: "var(--font-mono)" }}
                    value={v.value}
                    onChange={(e) => updateVar(i, "value", e.target.value)}
                    placeholder="value"
                  />
                  <button
                    type="button"
                    onClick={() => removeVar(i)}
                    className="shrink-0 rounded-md p-1.5 text-[var(--text-muted)] hover:bg-red-500/10 hover:text-red-400"
                    title="Remove variable"
                  >
                    ×
                  </button>
                </div>
              ))}
              {variables.length === 0 ? (
                <p className="text-xs text-[var(--text-muted)]">
                  No variables defined.
                </p>
              ) : null}
            </div>
          </div>

          {/* Pipeline secrets card */}
          <div className="flex flex-col gap-4 rounded-[10px] border border-[var(--divider)] bg-[var(--bg-surface)] p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-[15px] font-semibold">Pipeline Secrets</h2>
              <button
                type="button"
                onClick={submitPipelineSecret}
                disabled={createPipelineSecretMut.isPending}
                className="text-xs font-medium text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {createPipelineSecretMut.isPending ? "Saving..." : "+ Add"}
              </button>
            </div>
            <p className="text-xs text-[var(--text-muted)]">
              Secrets apply only to this pipeline and override global secrets
              with the same name.
            </p>
            <div className="flex items-center gap-2">
              <input
                className="min-w-0 flex-1 rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3 py-2 text-xs uppercase focus:border-[var(--accent)] focus:outline-none"
                style={{ fontFamily: "var(--font-mono)" }}
                value={pipelineSecretName}
                onChange={(e) => setPipelineSecretName(e.target.value)}
                placeholder="name"
              />
              <input
                type="password"
                className="min-w-0 flex-1 rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3 py-2 text-xs focus:border-[var(--accent)] focus:outline-none"
                style={{ fontFamily: "var(--font-mono)" }}
                value={pipelineSecretValue}
                onChange={(e) => setPipelineSecretValue(e.target.value)}
                placeholder="value"
              />
              <button
                type="button"
                onClick={submitPipelineSecret}
                disabled={createPipelineSecretMut.isPending}
                className="shrink-0 rounded-md px-2 py-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-inset)] hover:text-[var(--text-secondary)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {createPipelineSecretMut.isPending ? "..." : "+"}
              </button>
            </div>
            {pipelineSecretError ? (
              <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                {pipelineSecretError}
              </p>
            ) : null}
            {pipelineSecretSuccess ? (
              <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
                {pipelineSecretSuccess}
              </p>
            ) : null}
            <div className="flex flex-col gap-2">
              {pipelineSecretsQ.isLoading ? (
                <p className="text-xs text-[var(--text-muted)]">
                  Loading pipeline secrets...
                </p>
              ) : null}
              {pipelineSecretsQ.data?.length === 0 ? (
                <p className="text-xs text-[var(--text-muted)]">
                  No pipeline secrets yet.
                </p>
              ) : null}
              {pipelineSecretsQ.data?.map((secret) => (
                <div
                  key={secret.id}
                  className="flex items-center justify-between rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3 py-2"
                >
                  <div>
                    <p
                      className="text-xs font-medium uppercase"
                      style={{ fontFamily: "var(--font-mono)" }}
                    >
                      {secret.name}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setPipelineSecretError(null);
                        setPipelineSecretSuccess(null);
                        setPipelineSecretUpdateValue("");
                        setPipelineSecretUpdateName(secret.name);
                      }}
                      className="cursor-pointer rounded border border-[var(--divider)] px-2 py-1 text-[11px] text-[var(--text-secondary)]"
                    >
                      Rotate
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        deletePipelineSecretMut.mutate(secret.name)
                      }
                      disabled={deletePipelineSecretMut.isPending}
                      className="cursor-pointer rounded border border-red-500/30 px-2 py-1 text-[11px] text-red-300 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {pipelineSecretUpdateName ? (
              <div className="rounded-[8px] border border-[var(--divider)] bg-[var(--bg-inset)] p-3">
                <p
                  className="mb-2 text-xs text-[var(--text-secondary)]"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  Rotate {pipelineSecretUpdateName}
                </p>
                <input
                  type="password"
                  className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-surface)] px-3 py-2 text-xs focus:border-[var(--accent)] focus:outline-none"
                  style={{ fontFamily: "var(--font-mono)" }}
                  value={pipelineSecretUpdateValue}
                  onChange={(e) => setPipelineSecretUpdateValue(e.target.value)}
                  placeholder="New value"
                />
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={submitPipelineSecretUpdate}
                    disabled={updatePipelineSecretMut.isPending}
                    className="cursor-pointer rounded bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--bg-primary)] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {updatePipelineSecretMut.isPending
                      ? "Updating..."
                      : "Update"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPipelineSecretUpdateName(null);
                      setPipelineSecretUpdateValue("");
                    }}
                    className="cursor-pointer rounded border border-[var(--divider)] px-3 py-1.5 text-xs text-[var(--text-secondary)]"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          {/* YAML editor */}
          <div className="flex flex-col gap-4 rounded-[10px] border border-[var(--divider)] bg-[var(--bg-surface)] p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-[15px] font-semibold">YAML</h2>
              <button
                type="button"
                onClick={() => setYamlMode(!yamlMode)}
                className={`rounded-[6px] px-2.5 py-1 text-[11px] font-semibold ${
                  yamlMode
                    ? "bg-[var(--accent)] text-[var(--bg-primary)]"
                    : "bg-[var(--bg-inset)] text-[var(--text-secondary)]"
                }`}
              >
                {yamlMode ? "Editing YAML" : "View only"}
              </button>
            </div>
            <textarea
              className="min-h-[180px] w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] p-3 text-xs leading-relaxed focus:border-[var(--accent)] focus:outline-none"
              style={{ fontFamily: "var(--font-mono)" }}
              value={yamlMode ? rawYaml : YAML.stringify(buildDefinition())}
              onChange={(e) => yamlMode && setRawYaml(e.target.value)}
              readOnly={!yamlMode}
            />
          </div>
        </div>

        {/* Right panel — Steps */}
        <div className="flex flex-1 flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 className="text-[15px] font-semibold">
              Steps ({steps.length})
            </h2>
            <button
              type="button"
              onClick={addStep}
              className="flex items-center gap-1.5 rounded-[6px] bg-[var(--accent)] px-3 py-1.5 text-[13px] font-semibold text-[var(--bg-primary)]"
            >
              + Add Step
            </button>
          </div>

          {steps.map((step, idx) => {
            const isExpanded = expandedStep === idx;
            const previousSteps = steps.slice(0, idx);
            const promptTemplateWarning = getPromptTemplateWarning(
              step.prompt,
              steps.map((s) => s.id),
            );
            const sections = sectionStateFor(idx);
            const promptSummary = `${step.prompt.trim().length} chars`;
            const allowlistCount = (step.networkAllowlist || "")
              .split(",")
              .map((v) => v.trim())
              .filter(Boolean).length;
            const tools = step.tools || [];
            const toolTypeCounts = tools.reduce<Record<string, number>>(
              (acc, tool) => {
                acc[tool.type] = (acc[tool.type] || 0) + 1;
                return acc;
              },
              {},
            );
            return (
              <div
                key={step.id}
                className={`rounded-[10px] border bg-[var(--bg-surface)] transition-colors ${
                  isExpanded
                    ? "border-[var(--accent)]"
                    : "border-[var(--divider)]"
                }`}
              >
                {/* Step header — always visible */}
                <button
                  type="button"
                  className="flex w-full items-center justify-between px-5 py-4"
                  onClick={() => setExpandedStep(isExpanded ? -1 : idx)}
                >
                  <div className="flex items-center gap-2.5">
                    <div
                      className={`grid size-6 place-items-center rounded-[6px] text-[11px] font-bold ${
                        isExpanded
                          ? "bg-[var(--accent)] text-[var(--bg-primary)]"
                          : "bg-[var(--bg-inset)] text-[var(--text-secondary)]"
                      }`}
                      style={{ fontFamily: "var(--font-mono)" }}
                    >
                      {idx + 1}
                    </div>
                    <span
                      className={`text-sm ${isExpanded ? "font-semibold" : "font-medium"}`}
                    >
                      {step.name || `Step ${idx + 1}`}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className="rounded-full bg-[var(--bg-inset)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-secondary)]"
                      style={{ fontFamily: "var(--font-mono)" }}
                    >
                      {step.model}
                    </span>
                    <span className="text-[var(--text-muted)]">
                      {isExpanded ? "▲" : "▼"}
                    </span>
                  </div>
                </button>

                {/* Expanded edit form */}
                {isExpanded ? (
                  <div className="border-t border-[var(--divider)] px-5 pb-5 pt-4">
                    <div className="flex flex-col gap-4">
                      {/* Name + Model row */}
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <label className="flex flex-col gap-1.5">
                          <span className="text-xs font-medium text-[var(--text-secondary)]">
                            Step Name
                          </span>
                          <input
                            className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3.5 py-2.5 text-[13px] focus:border-[var(--accent)] focus:outline-none"
                            value={step.name}
                            onChange={(e) =>
                              updateStep(idx, { name: e.target.value })
                            }
                          />
                        </label>
                        <label className="flex flex-col gap-1.5">
                          <span className="text-xs font-medium text-[var(--text-secondary)]">
                            Model
                          </span>
                          <select
                            className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3.5 py-2.5 text-[13px] focus:border-[var(--accent)] focus:outline-none"
                            style={{ fontFamily: "var(--font-mono)" }}
                            value={step.model}
                            onChange={(e) =>
                              updateStep(idx, { model: e.target.value })
                            }
                          >
                            {modelOptions.map((model) => (
                              <option key={model.id} value={model.id}>
                                {model.label}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>

                      <div className="rounded-[8px] border border-[var(--divider)] bg-[var(--bg-inset)]">
                        <button
                          type="button"
                          className="flex w-full items-center justify-between px-3 py-2.5"
                          onClick={() => toggleStepSection(idx, "prompt")}
                          aria-expanded={sections.prompt}
                        >
                          <span className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
                            Prompt
                          </span>
                          <span className="flex items-center gap-3 text-[11px] text-[var(--text-muted)]">
                            <span>{promptSummary}</span>
                            <span>{sections.prompt ? "▲" : "▼"}</span>
                          </span>
                        </button>
                        {sections.prompt ? (
                          <label className="flex flex-col gap-1.5 border-t border-[var(--divider)] px-3 pb-3 pt-2.5">
                            <textarea
                              className="min-h-[100px] w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-surface)] px-3.5 py-2.5 text-[13px] leading-relaxed focus:border-[var(--accent)] focus:outline-none"
                              value={step.prompt}
                              ref={(el) => {
                                promptRefs.current[idx] = el;
                              }}
                              onChange={(e) =>
                                updateStep(idx, { prompt: e.target.value })
                              }
                              placeholder="Enter the prompt for this step..."
                            />
                            <div className="flex flex-wrap items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() =>
                                  insertPromptToken(idx, "{{input.topic}}")
                                }
                                className="rounded border border-[var(--divider)] bg-[var(--bg-surface)] px-2 py-1 text-[11px] text-[var(--text-secondary)]"
                              >
                                + input.topic
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  insertPromptToken(idx, "{{vars.language}}")
                                }
                                className="rounded border border-[var(--divider)] bg-[var(--bg-surface)] px-2 py-1 text-[11px] text-[var(--text-secondary)]"
                              >
                                + vars.language
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  insertPromptToken(idx, "{{env.OPENAI_API_KEY}}")
                                }
                                className="rounded border border-[var(--divider)] bg-[var(--bg-surface)] px-2 py-1 text-[11px] text-[var(--text-secondary)]"
                              >
                                + env.OPENAI_API_KEY
                              </button>
                              {previousSteps.length > 0 &&
                              previousSteps.length <= 4
                                ? previousSteps.map((prevStep, prevIdx) => (
                                    <button
                                      key={`${prevStep.id}-token`}
                                      type="button"
                                      onClick={() =>
                                        insertPromptToken(
                                          idx,
                                          `{{steps.${prevStep.id}.output}}`,
                                        )
                                      }
                                      className="rounded border border-[var(--divider)] bg-[var(--bg-surface)] px-2 py-1 text-[11px] text-[var(--text-secondary)]"
                                      title={`Also available: {{steps.${prevIdx + 1}.output}}`}
                                    >
                                      + steps.{prevStep.id}.output
                                    </button>
                                  ))
                                : null}
                              {previousSteps.length > 4 ? (
                                <div className="flex items-center gap-1.5">
                                  <select
                                    className="rounded border border-[var(--divider)] bg-[var(--bg-surface)] px-2 py-1 text-[11px] text-[var(--text-secondary)]"
                                    style={{ fontFamily: "var(--font-mono)" }}
                                    value={selectedPrevStepToken[idx] || ""}
                                    onChange={(e) =>
                                      setSelectedPrevStepToken((prev) => ({
                                        ...prev,
                                        [idx]: e.target.value,
                                      }))
                                    }
                                  >
                                    <option value="">
                                      Select step output...
                                    </option>
                                    {previousSteps.map((prevStep, prevIdx) => (
                                      <option
                                        key={`${prevStep.id}-token-option`}
                                        value={`{{steps.${prevStep.id}.output}}`}
                                      >
                                        {`${prevIdx + 1}. ${prevStep.name || prevStep.id} (${prevStep.id})`}
                                      </option>
                                    ))}
                                  </select>
                                  <button
                                    type="button"
                                    disabled={!selectedPrevStepToken[idx]}
                                    onClick={() =>
                                      selectedPrevStepToken[idx] &&
                                      insertPromptToken(
                                        idx,
                                        selectedPrevStepToken[idx],
                                      )
                                    }
                                    className="rounded border border-[var(--divider)] bg-[var(--bg-surface)] px-2 py-1 text-[11px] text-[var(--text-secondary)] disabled:cursor-not-allowed disabled:opacity-50"
                                  >
                                    + Insert step output
                                  </button>
                                </div>
                              ) : null}
                            </div>
                            <p className="text-[11px] text-[var(--text-muted)]">
                              Supports: <code>{"{{input.field}}"}</code>,{" "}
                              <code>{"{{vars.name}}"}</code>,{" "}
                              <code>{"{{steps.step_1.output}}"}</code>,{" "}
                              <code>{"{{steps.1.output}}"}</code>,{" "}
                              <code>{"{{env.OPENAI_API_KEY}}"}</code>.
                            </p>
                            {promptTemplateWarning ? (
                              <p className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200">
                                {promptTemplateWarning}
                              </p>
                            ) : null}
                          </label>
                        ) : null}
                      </div>

                      {/* Config row — Output Format, Timeout, Retries */}
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                        <label className="flex flex-col gap-1.5">
                          <span className="text-xs font-medium text-[var(--text-secondary)]">
                            Output Format
                          </span>
                          <select
                            className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3 py-2 text-xs focus:border-[var(--accent)] focus:outline-none"
                            style={{ fontFamily: "var(--font-mono)" }}
                            value={step.outputFormat || "text"}
                            onChange={(e) =>
                              updateStep(idx, { outputFormat: e.target.value })
                            }
                          >
                            <option value="text">text</option>
                            <option value="json">json</option>
                            <option value="markdown">markdown</option>
                          </select>
                        </label>
                        <label className="flex flex-col gap-1.5">
                          <span className="text-xs font-medium text-[var(--text-secondary)]">
                            Timeout (s)
                          </span>
                          <input
                            type="number"
                            className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3 py-2 text-xs focus:border-[var(--accent)] focus:outline-none"
                            style={{ fontFamily: "var(--font-mono)" }}
                            value={step.timeout ?? 30}
                            onChange={(e) =>
                              updateStep(idx, {
                                timeout: Number(e.target.value),
                              })
                            }
                            min={1}
                            max={300}
                          />
                        </label>
                        <label className="flex flex-col gap-1.5">
                          <span className="text-xs font-medium text-[var(--text-secondary)]">
                            Retries
                          </span>
                          <input
                            type="number"
                            className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3 py-2 text-xs focus:border-[var(--accent)] focus:outline-none"
                            style={{ fontFamily: "var(--font-mono)" }}
                            value={step.retries ?? 2}
                            onChange={(e) =>
                              updateStep(idx, {
                                retries: Number(e.target.value),
                              })
                            }
                            min={0}
                            max={10}
                          />
                        </label>
                      </div>

                      {step.type === "llm" ? (
                        <>
                          <div className="rounded-[8px] border border-[var(--divider)] bg-[var(--bg-inset)]">
                            <button
                              type="button"
                              className="flex w-full items-center justify-between px-3 py-2.5"
                              onClick={() => toggleStepSection(idx, "runtime")}
                              aria-expanded={sections.runtime}
                            >
                              <span className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
                                Agent Runtime
                              </span>
                              <span className="flex items-center gap-3 text-[11px] text-[var(--text-muted)]">
                                <span>
                                  Turns {step.agentMaxTurns ?? 8} ·{" "}
                                  {step.agentMaxDurationSeconds ?? 45}s · Calls{" "}
                                  {step.agentMaxToolCalls ?? 3}
                                </span>
                                <span>
                                  Allowlist: {allowlistCount || "none"}
                                </span>
                                <span>{sections.runtime ? "▲" : "▼"}</span>
                              </span>
                            </button>
                            <p className="px-3 pb-2 text-[11px] text-[var(--text-muted)]">
                              Controls how autonomously the model can reason and
                              how much time/tool budget it can use.
                            </p>
                            {sections.runtime ? (
                              <div className="grid grid-cols-1 gap-3 border-t border-[var(--divider)] px-3 pb-3 pt-2.5 sm:grid-cols-3">
                                <label className="flex flex-col gap-1.5">
                                  <span className="text-xs font-medium text-[var(--text-secondary)]">
                                    Max Turns
                                  </span>
                                  <input
                                    type="number"
                                    className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-surface)] px-3 py-2 text-xs focus:border-[var(--accent)] focus:outline-none"
                                    value={step.agentMaxTurns ?? 8}
                                    onChange={(e) =>
                                      updateStep(idx, {
                                        agentMaxTurns: Number(e.target.value),
                                      })
                                    }
                                    min={1}
                                    max={50}
                                  />
                                </label>
                                <label className="flex flex-col gap-1.5">
                                  <span className="text-xs font-medium text-[var(--text-secondary)]">
                                    Max Duration (s)
                                  </span>
                                  <input
                                    type="number"
                                    className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-surface)] px-3 py-2 text-xs focus:border-[var(--accent)] focus:outline-none"
                                    value={step.agentMaxDurationSeconds ?? 45}
                                    onChange={(e) =>
                                      updateStep(idx, {
                                        agentMaxDurationSeconds: Number(
                                          e.target.value,
                                        ),
                                      })
                                    }
                                    min={1}
                                    max={300}
                                  />
                                </label>
                                <label className="flex flex-col gap-1.5">
                                  <span className="text-xs font-medium text-[var(--text-secondary)]">
                                    Max Tool Calls
                                  </span>
                                  <input
                                    type="number"
                                    className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-surface)] px-3 py-2 text-xs focus:border-[var(--accent)] focus:outline-none"
                                    value={step.agentMaxToolCalls ?? 3}
                                    onChange={(e) =>
                                      updateStep(idx, {
                                        agentMaxToolCalls: Number(
                                          e.target.value,
                                        ),
                                      })
                                    }
                                    min={0}
                                    max={50}
                                  />
                                </label>
                                <label className="sm:col-span-3 flex flex-col gap-1.5">
                                  <span className="text-xs font-medium text-[var(--text-secondary)]">
                                    Network Allowlist (comma-separated domains)
                                  </span>
                                  <input
                                    className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-surface)] px-3 py-2 text-xs focus:border-[var(--accent)] focus:outline-none"
                                    value={step.networkAllowlist || ""}
                                    onChange={(e) =>
                                      updateStep(idx, {
                                        networkAllowlist: e.target.value,
                                      })
                                    }
                                    placeholder="connect.garmin.com, garmin.com"
                                  />
                                </label>
                              </div>
                            ) : null}
                          </div>

                          <div className="rounded-[8px] border border-[var(--divider)] bg-[var(--bg-inset)]">
                            <button
                              type="button"
                              className="flex w-full items-center justify-between px-3 py-2.5"
                              onClick={() => toggleStepSection(idx, "tools")}
                              aria-expanded={sections.tools}
                            >
                              <span className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
                                Tools
                              </span>
                              <span className="flex items-center gap-3 text-[11px] text-[var(--text-muted)]">
                                <span>{tools.length} configured</span>
                                <span className="capitalize">
                                  {Object.entries(toolTypeCounts)
                                    .map(([type, count]) => `${type}:${count}`)
                                    .join(" · ") || "none"}
                                </span>
                                <span>{sections.tools ? "▲" : "▼"}</span>
                              </span>
                            </button>
                            <p className="px-3 pb-2 text-[11px] text-[var(--text-muted)]">
                              Define callable functions the agent can use during
                              execution (HTTP, extraction, templating, and JS).
                            </p>
                            {sections.tools ? (
                              <div className="border-t border-[var(--divider)] px-3 pb-3 pt-2.5">
                                <div className="mb-3 flex items-center justify-end">
                                  <button
                                    type="button"
                                    onClick={() => addTool(idx)}
                                    className="rounded border border-[var(--divider)] bg-[var(--bg-surface)] px-2 py-1 text-[11px] text-[var(--text-secondary)]"
                                  >
                                    + Add Tool
                                  </button>
                                </div>
                                <div className="flex flex-col gap-3">
                                  {tools.map((tool, toolIdx) => {
                                    const expanded = isToolExpanded(
                                      idx,
                                      toolIdx,
                                    );
                                    const schemaValid =
                                      !tool.inputSchema?.trim() ||
                                      (() => {
                                        try {
                                          JSON.parse(tool.inputSchema || "{}");
                                          return true;
                                        } catch {
                                          return false;
                                        }
                                      })();
                                    const hasWarning =
                                      !tool.name.trim() ||
                                      !schemaValid ||
                                      (tool.type === "js" &&
                                        !tool.jsSource?.trim());
                                    const missingConfigItems: string[] = [];
                                    if (!tool.name.trim()) {
                                      missingConfigItems.push(
                                        "Tool name is required",
                                      );
                                    }
                                    if (!schemaValid) {
                                      missingConfigItems.push(
                                        "Input schema must be valid JSON",
                                      );
                                    }
                                    if (tool.type === "js" && !tool.jsSource?.trim()) {
                                      missingConfigItems.push(
                                        "JavaScript source is required for js tools",
                                      );
                                    }
                                    const warningTooltip =
                                      missingConfigItems.length > 0
                                        ? `Missing configuration:\n- ${missingConfigItems.join(
                                            "\n- ",
                                          )}`
                                        : undefined;
                                    return (
                                      <div
                                        key={`${step.id}-tool-${toolIdx}`}
                                        className="rounded border border-[var(--divider)] bg-[var(--bg-surface)]"
                                      >
                                        <button
                                          type="button"
                                          className="flex w-full items-center justify-between px-3 py-2.5 text-left"
                                          onClick={() =>
                                            toggleToolExpanded(idx, toolIdx)
                                          }
                                          aria-expanded={expanded}
                                        >
                                          <span className="flex items-center gap-2">
                                            <span className="rounded bg-[var(--bg-inset)] px-2 py-0.5 text-[10px] uppercase text-[var(--text-secondary)]">
                                              {tool.type}
                                            </span>
                                            <span className="text-xs font-medium">
                                              {tool.name || `Tool ${toolIdx + 1}`}
                                            </span>
                                            {hasWarning ? (
                                              <span
                                                className="rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-200"
                                                title={warningTooltip}
                                                aria-label={warningTooltip}
                                              >
                                                Needs config
                                              </span>
                                            ) : null}
                                          </span>
                                          <span className="text-[11px] text-[var(--text-muted)]">
                                            {expanded ? "▲" : "▼"}
                                          </span>
                                        </button>
                                        {expanded ? (
                                          <div className="border-t border-[var(--divider)] p-3">
                                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                                              <label className="flex flex-col gap-1">
                                                <span className="text-[10px] uppercase text-[var(--text-muted)]">
                                                  Tool Type
                                                </span>
                                                <select
                                                  className="rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-2 py-2 text-xs focus:border-[var(--accent)] focus:outline-none"
                                                  value={tool.type}
                                                  onChange={(e) =>
                                                    updateTool(idx, toolIdx, {
                                                      type:
                                                        e.target
                                                          .value as StepToolDef["type"],
                                                    })
                                                  }
                                                >
                                                  <option value="http_request">
                                                    http_request
                                                  </option>
                                                  <option value="extract_json">
                                                    extract_json
                                                  </option>
                                                  <option value="template_render">
                                                    template_render
                                                  </option>
                                                  <option value="js">js</option>
                                                  <option value="curl">
                                                    curl
                                                  </option>
                                                  <option value="gh">gh</option>
                                                  <option value="gogcli">
                                                    gogcli
                                                  </option>
                                                </select>
                                              </label>
                                              <label className="flex flex-col gap-1">
                                                <span className="text-[10px] uppercase text-[var(--text-muted)]">
                                                  Tool Name
                                                </span>
                                                <input
                                                  className="rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-2 py-2 text-xs focus:border-[var(--accent)] focus:outline-none"
                                                  value={tool.name}
                                                  onChange={(e) =>
                                                    updateTool(idx, toolIdx, {
                                                      name: e.target.value,
                                                    })
                                                  }
                                                  placeholder="tool_name"
                                                />
                                              </label>
                                              <button
                                                type="button"
                                                onClick={() =>
                                                  removeTool(idx, toolIdx)
                                                }
                                                className="self-end rounded-[6px] border border-red-500/30 px-2 py-2 text-xs text-red-300"
                                              >
                                                Remove
                                              </button>
                                            </div>
                                            <label className="mt-2 flex flex-col gap-1">
                                              <span className="text-[10px] uppercase text-[var(--text-muted)]">
                                                Description
                                              </span>
                                              <input
                                                className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-2 py-2 text-xs focus:border-[var(--accent)] focus:outline-none"
                                                value={tool.description || ""}
                                                onChange={(e) =>
                                                  updateTool(idx, toolIdx, {
                                                    description: e.target.value,
                                                  })
                                                }
                                                placeholder="What this tool does"
                                              />
                                            </label>
                                            <div className="mt-2 flex flex-col gap-1">
                                              <span className="text-[10px] uppercase text-[var(--text-muted)]">
                                                Input Schema (JSON)
                                              </span>
                                              <CodeSourceEditor
                                                value={tool.inputSchema || ""}
                                                onChange={(e) =>
                                                  updateTool(idx, toolIdx, {
                                                    inputSchema: e,
                                                  })
                                                }
                                                language="json"
                                                minRows={4}
                                                placeholder='{"type":"object","properties":{}}'
                                              />
                                            </div>
                                            {!schemaValid ? (
                                              <p className="mt-1 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200">
                                                Input schema is not valid JSON.
                                              </p>
                                            ) : null}
                                            {tool.type === "js" ? (
                                              <div className="mt-2 flex flex-col gap-1">
                                                <span className="text-[10px] uppercase text-[var(--text-muted)]">
                                                  JavaScript Source
                                                </span>
                                                <CodeSourceEditor
                                                  value={tool.jsSource || ""}
                                                  onChange={(next) =>
                                                    updateTool(idx, toolIdx, {
                                                      jsSource: next,
                                                    })
                                                  }
                                                  language="javascript"
                                                  placeholder="(args) => ({ ok: true })"
                                                />
                                              </div>
                                            ) : null}
                                          </div>
                                        ) : null}
                                      </div>
                                    );
                                  })}
                                </div>
                                {tools.length === 0 ? (
                                  <p className="text-[11px] text-[var(--text-muted)]">
                                    No tools configured. Add tools to let the
                                    agent call external APIs or transforms.
                                  </p>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        </>
                      ) : null}

                      {/* Step actions */}
                      <div className="flex items-center justify-between border-t border-[var(--divider)] pt-3">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => moveStep(idx, -1)}
                            disabled={idx === 0}
                            className="rounded-[6px] border border-[var(--divider)] px-2 py-1 text-xs text-[var(--text-secondary)] disabled:opacity-30"
                            title="Move up"
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            onClick={() => moveStep(idx, 1)}
                            disabled={idx === steps.length - 1}
                            className="rounded-[6px] border border-[var(--divider)] px-2 py-1 text-xs text-[var(--text-secondary)] disabled:opacity-30"
                            title="Move down"
                          >
                            ↓
                          </button>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeStep(idx)}
                          className="rounded-[6px] border border-red-500/30 px-3 py-1 text-xs font-medium text-red-400 hover:bg-red-500/10"
                        >
                          Remove step
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}

          {steps.length === 0 ? (
            <div className="rounded-[10px] border border-dashed border-[var(--divider)] p-8 text-center">
              <p className="text-sm text-[var(--text-tertiary)]">
                No steps yet.
              </p>
              <button
                type="button"
                onClick={addStep}
                className="mt-3 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--bg-primary)]"
              >
                Add your first step
              </button>
            </div>
          ) : null}

          {/* Output webhook card */}
          <div className="flex flex-col gap-4 rounded-[10px] border border-[var(--divider)] bg-[var(--bg-surface)] p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-[15px] font-semibold">Output Webhook</h2>
              <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                <input
                  type="checkbox"
                  checked={outputWebhookEnabled}
                  onChange={(e) => setOutputWebhookEnabled(e.target.checked)}
                />
                Enabled
              </label>
            </div>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-[var(--text-secondary)]">
                Output From Step
              </span>
              <select
                className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3.5 py-2.5 text-[13px] focus:border-[var(--accent)] focus:outline-none"
                style={{ fontFamily: "var(--font-mono)" }}
                value={outputFromStepId}
                onChange={(e) => setOutputFromStepId(e.target.value)}
              >
                {steps.map((step) => (
                  <option key={`out-from-${step.id}`} value={step.id}>
                    {step.id}
                  </option>
                ))}
              </select>
            </label>
            {outputWebhookEnabled ? (
              <>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-[var(--text-secondary)]">
                    Webhook URL
                  </span>
                  <input
                    className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3.5 py-2.5 text-[13px] focus:border-[var(--accent)] focus:outline-none"
                    value={outputWebhookUrl}
                    onChange={(e) => setOutputWebhookUrl(e.target.value)}
                    placeholder="https://example.com/hooks/stepiq"
                  />
                </label>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-[var(--text-secondary)]">
                      Method
                    </span>
                    <select
                      className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3.5 py-2.5 text-[13px] focus:border-[var(--accent)] focus:outline-none"
                      style={{ fontFamily: "var(--font-mono)" }}
                      value={outputWebhookMethod}
                      onChange={(e) =>
                        setOutputWebhookMethod(
                          (e.target.value as "POST" | "PUT" | "GET") || "POST",
                        )
                      }
                    >
                      <option value="POST">POST</option>
                      <option value="PUT">PUT</option>
                      <option value="GET">GET</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-[var(--text-secondary)]">
                      Signing Secret Name
                    </span>
                    <input
                      className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3.5 py-2.5 font-[var(--font-mono)] text-[13px] uppercase focus:border-[var(--accent)] focus:outline-none"
                      value={outputWebhookSigningSecret}
                      onChange={(e) =>
                        setOutputWebhookSigningSecret(e.target.value)
                      }
                      placeholder="WEBHOOK_SIGNING_SECRET"
                    />
                  </label>
                </div>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function StatusBadge({ status }: { status: string }) {
  const isActive = status === "active" || status === "running";
  const bg = isActive ? "#22C55E20" : "#EAB30820";
  const fg = isActive ? "#22C55E" : "#EAB308";
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
