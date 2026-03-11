import { describe, expect, it } from "bun:test";
import { templateRenderTool } from "../../../agent-runtime/tools/template-render.js";

describe("templateRenderTool", () => {
  it("renders handlebars template", async () => {
    const result = await templateRenderTool(
      { template: "Hello {{name}}", context: { name: "Val" } },
      {
        tool: { type: "template_render", name: "tpl" },
        debugLabel: "test",
        allowedList: [],
        runCommand: async () => {
          throw new Error("unused");
        },
      },
    );

    expect(result).toEqual({ ok: true, output: "Hello Val" });
  });
});
