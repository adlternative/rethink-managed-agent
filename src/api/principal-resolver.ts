import { apiKeys } from "../infra/db.ts";
import { env } from "../shared/env.ts";
import { ApiError } from "./errors.ts";
import type { Principal } from "../shared/types.ts";

/**
 * The identity seam. rethink owns the *isolation* boundary (owner_id on every resource, enforced in
 * the repos); it does NOT own what a "user"/"org"/"tenant" means. A deployment plugs in how a
 * credential becomes a principal by pointing PRINCIPAL_RESOLVER at a module that default-exports a
 * `PrincipalResolver`. Everything downstream only ever sees `owner`.
 *
 * A resolver returns:
 *   - a ResolvedIdentity  -> the request is authenticated as that actor (and optionally an org owner)
 *   - null                -> no credential was presented; the middleware then applies AUTH_REQUIRED
 *                            (401) or the dev default principal
 * or throws ApiError(401) for a credential that was presented but is invalid.
 */
export interface ResolveRequest {
  header(name: string): string | undefined;
  method: string;
  path: string;
}
export interface ResolvedIdentity {
  /** who is calling */
  actor: Principal;
  /** the owning scope for this request; defaults to actor.id. A resolver that supports orgs returns the org principal here (after checking membership). */
  owner?: string;
}
export interface PrincipalResolver {
  resolve(req: ResolveRequest): Promise<ResolvedIdentity | null>;
}

/** Built-in default: `Authorization: Bearer <token>` resolved against the api_keys table. */
export const bearerApiKeyResolver: PrincipalResolver = {
  async resolve(req) {
    const header = req.header("authorization");
    const token = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : null;
    if (!token) return null; // no credential -> let the middleware decide (default principal or 401)
    const actor = await apiKeys.resolve(token);
    if (!actor) throw new ApiError(401, "authentication_error", "invalid or expired API key");
    return { actor };
  },
};

let cached: Promise<PrincipalResolver> | null = null;
/** The configured resolver: a module named by PRINCIPAL_RESOLVER (default-exporting one), else the built-in. */
export function loadResolver(): Promise<PrincipalResolver> {
  if (!cached) {
    cached = env.PRINCIPAL_RESOLVER
      ? import(env.PRINCIPAL_RESOLVER).then((m) => {
          const r = (m.default ?? m.resolver) as PrincipalResolver | undefined;
          if (!r || typeof r.resolve !== "function") throw new Error(`PRINCIPAL_RESOLVER ${env.PRINCIPAL_RESOLVER} must default-export a { resolve } PrincipalResolver`);
          console.log(`[auth] using principal resolver from ${env.PRINCIPAL_RESOLVER}`);
          return r;
        })
      : Promise.resolve(bearerApiKeyResolver);
  }
  return cached;
}

/** test seam: force a resolver (or reset to the configured one with undefined). */
export function setResolver(r: PrincipalResolver | undefined): void {
  cached = r ? Promise.resolve(r) : null;
}
