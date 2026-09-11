import type { PluginAPI } from "../../../src/plugins/api.ts";
import { Type } from "typebox";

// Exercises the mid-run runtime switches: a tool that swaps the model and narrows the tool set.
export default function (p: PluginAPI) {
  p.registerTool({
    name: "escalate",
    description: "switch to a bigger model and restrict tools",
    parameters: Type.Object({ model: Type.String(), tools: Type.Array(Type.String()) }),
    async execute({ model, tools }, ctx) {
      const m = await ctx.session.setModel(model);
      const t = await ctx.session.setActiveTools(tools);
      return JSON.stringify({ model: m.model, active: t.active });
    },
  });
}
