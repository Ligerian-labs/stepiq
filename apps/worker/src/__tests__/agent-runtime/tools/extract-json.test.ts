import { describe, expect, it } from "bun:test";
import { extractJsonTool } from "../../../agent-runtime/tools/extract-json.js";

describe("extractJsonTool", () => {
  it("extracts nested value by path", async () => {
    const result = await extractJsonTool(
      { text: JSON.stringify({ a: { b: 42 } }), path: "a.b" },
      {
        tool: { type: "extract_json", name: "extractor" },
        debugLabel: "test",
        allowedList: [],
        runCommand: async () => {
          throw new Error("unused");
        },
      },
    );

    expect(result).toEqual({ ok: true, value: 42 });
  });
});
