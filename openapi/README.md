# OpenAPI (native `/v1`)

- **Spec:** [`v1.yaml`](v1.yaml) — checked into the repo; also served by the API at `GET /openapi/v1.yaml`.
- **Inventory:** [`route-inventory.ts`](route-inventory.ts) — path templates that must appear in the YAML.

## Keeping it honest

```sh
make openapi-check   # or: npx tsx scripts/openapi-check.ts && npx vitest run test/openapi-drift.test.ts
```

When you add or remove a native `/v1` handler:

1. Update the route under `src/api/routes/`.
2. Add/remove the path in `route-inventory.ts`.
3. Document it in `v1.yaml` (hand-maintained; no codegen required for v1).
4. Run `make openapi-check` — it fails on drift.

Compat dialects (`/openai/v1`, `/anthropic`, `/agents-api/v1`) are **not** in this file.
