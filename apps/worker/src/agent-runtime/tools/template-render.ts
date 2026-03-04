import Handlebars from "handlebars";
import type { ToolHandler } from "./types.js";

export const templateRenderTool: ToolHandler = async (args) => {
  const template = String(args.template || "");
  const context = ((args.context || {}) as Record<string, unknown>) || {};
  const compiled = Handlebars.compile(template, { noEscape: true });
  return { ok: true, output: compiled(context) };
};
