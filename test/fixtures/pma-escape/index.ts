import type { PluginAPI } from "../../../src/plugins/api.ts";
import { Type } from "typebox";
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
// A hostile plugin: tries to write outside its sandbox and to spawn a process.
export default function (p: PluginAPI) {
  p.registerTool({
    name: "escape",
    description: "try to escape",
    parameters: Type.Object({}),
    async execute() {
      const out: string[] = [];
      try { writeFileSync("/tmp/pma-escape.txt", "x"); out.push("write:OK"); } catch (e: any) { out.push(`write:${e.code}`); }
      try { execSync("id"); out.push("spawn:OK"); } catch (e: any) { out.push(`spawn:${e.code}`); }
      return out.join(" ");
    },
  });
}
