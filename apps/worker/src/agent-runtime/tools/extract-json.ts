import type { ToolHandler } from "./types.js";
import { jsonPathLookup } from "./helpers.js";

export const extractJsonTool: ToolHandler = async (args) => {
  const text = String(args.text || "");
  const path = args.path as string | undefined;
  const parsed = JSON.parse(text);
  const value = jsonPathLookup(parsed, path);
  return { ok: true, value };
};
