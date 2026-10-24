/**
 * Fail when native `/v1` paths in `openapi/route-inventory.ts` drift from `openapi/v1.yaml`.
 *
 * Usage: `make openapi-check`  (or `npx tsx scripts/openapi-check.ts`)
 *
 * Hand-maintain the YAML when handlers change; keep the inventory in sync. Live Hono registration
 * is cross-checked in `test/openapi-drift.test.ts`. Compat dialects are excluded.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { NATIVE_V1_ROUTES } from "../openapi/route-inventory.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function pathsFromOpenApi(yaml: string): Set<string> {
  const out = new Set<string>();
  for (const line of yaml.split("\n")) {
    const m = /^  (\/v1\/\S+):/.exec(line);
    if (m) out.add(m[1]!.replace(/\{([^}]+)\}/g, ":$1"));
  }
  return out;
}

const normalize = (p: string) => p.replace(/\/+$/, "") || "/";

const yaml = readFileSync(path.join(root, "openapi/v1.yaml"), "utf8");
const documented = pathsFromOpenApi(yaml);
const inventory = new Set(NATIVE_V1_ROUTES.map(normalize));

const missingInOpenApi = [...inventory].filter((p) => !documented.has(p)).sort();
const extraInOpenApi = [...documented].filter((p) => !inventory.has(p)).sort();

if (missingInOpenApi.length || extraInOpenApi.length) {
  console.error("OpenAPI drift detected.\n");
  if (missingInOpenApi.length) {
    console.error("In route inventory but missing from openapi/v1.yaml:");
    for (const p of missingInOpenApi) console.error(`  - ${p}`);
  }
  if (extraInOpenApi.length) {
    console.error("In openapi/v1.yaml but not in openapi/route-inventory.ts:");
    for (const p of extraInOpenApi) console.error(`  - ${p}`);
  }
  console.error("\nUpdate openapi/v1.yaml and/or openapi/route-inventory.ts, then re-run.");
  process.exit(1);
}

console.log(`openapi ok: ${documented.size} /v1 paths match route inventory`);
