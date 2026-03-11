import { getQuickJS } from "quickjs-emscripten";
import type { ToolHandler } from "./types.js";

async function evalQuickJS(code: string, args: unknown): Promise<unknown> {
  const QuickJS = await getQuickJS();
  const ctx = QuickJS.newContext();
  const argJson = JSON.stringify(args);
  const result = ctx.evalCode(`const __args=${argJson};\n${code}`) as {
    error?: { dispose: () => void };
    value?: { dispose: () => void };
  };

  try {
    if (result.error) {
      const err = ctx.dump(result.error as never);
      throw new Error(typeof err === "string" ? err : JSON.stringify(err));
    }
    const dumped = ctx.dump(result.value as never);
    if (typeof dumped !== "string") return dumped;
    try {
      return JSON.parse(dumped);
    } catch {
      return dumped;
    }
  } finally {
    if (result.error) {
      result.error.dispose();
    } else if (result.value) {
      result.value.dispose();
    }
    ctx.dispose();
  }
}

async function runQuickJSTool(source: string, args: unknown): Promise<unknown> {
  // Backward-compatible with function-style snippets.
  const fnExpr = `JSON.stringify(((${source}))(__args))`;
  try {
    return await evalQuickJS(fnExpr, args);
  } catch {
    // Fallback for script-style snippets exposing main(args).
    const script = `${source}\nJSON.stringify(typeof main === "function" ? main(__args) : undefined)`;
    return await evalQuickJS(script, args);
  }
}

export const jsTool: ToolHandler = async (args, context) => {
  const source = context.tool.js_source;
  if (!source) throw new Error(`JS source missing for tool ${context.tool.name}`);
  const output = await runQuickJSTool(source, args);
  return { ok: true, output };
};
