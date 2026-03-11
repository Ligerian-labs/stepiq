import { describe, expect, it } from "bun:test";
import { jsTool } from "../../../agent-runtime/tools/js.js";

const base = {
  debugLabel: "test",
  allowedList: [],
  runCommand: async () => {
    throw new Error("unused");
  },
};

describe("jsTool", () => {
  it("supports function-expression source", async () => {
    const result = await jsTool(
      { x: 2, y: 3 },
      {
        ...base,
        tool: {
          type: "js",
          name: "sum",
          js_source: "(args) => ({ sum: args.x + args.y })",
        },
      },
    );

    expect(result).toEqual({ ok: true, output: { sum: 5 } });
  });

  it("supports script-style source with main(args)", async () => {
    const result = await jsTool(
      { x: 4 },
      {
        ...base,
        tool: {
          type: "js",
          name: "script",
          js_source: 'function main(args){ const v = args.x * 2; return { value: v }; }',
        },
      },
    );

    expect(result).toEqual({ ok: true, output: { value: 8 } });
  });
});
