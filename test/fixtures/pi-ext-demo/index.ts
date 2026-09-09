// A minimal pi package used by the e2e: one registered tool, one tool_call guard hook, one skill.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "demo_secret",
    label: "Demo secret",
    description: "Returns the demo secret code for a given name. Use it whenever asked for a secret code.",
    parameters: Type.Object({ name: Type.String({ description: "who is asking" }) }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: `secret-code-for-${params.name}: PI-EXT-OK` }], details: {} };
    },
  });
  // Guard hook: a policy check that runs before a tool call reaches the sandbox. The e2e uses a
  // harmless marker so the model does not refuse on its own (as it does for `rm -rf /`).
  pi.on("tool_call", async (event) => {
    if (event.toolName === "bash" && /BLOCKME/.test(String((event.input as { command?: string }).command ?? ""))) {
      return { block: true, reason: "blocked by pi-ext-demo policy hook (command contains BLOCKME)" };
    }
    return undefined;
  });
}
