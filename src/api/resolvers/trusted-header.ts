import { principals } from "../../infra/db.ts";
import { env } from "../../shared/env.ts";
import { ApiError } from "../errors.ts";
import type { PrincipalResolver } from "../principal-resolver.ts";

/**
 * Example resolver: trust a principal id set by an upstream gateway that already authenticated the
 * end user (SSO/OIDC at the edge). Point PRINCIPAL_RESOLVER at this module. The header name is
 * TRUSTED_PRINCIPAL_HEADER (default `x-principal-id`); an optional `x-org-id` selects an org as the
 * owner scope (the business is responsible for having checked membership before setting it).
 *
 * SECURITY: only safe when rethink is reachable *exclusively* through that gateway and clients
 * cannot set these headers directly. This is the shape a consuming business plugs its own identity
 * into — most will write their own resolver (verify a JWT, map claims to principals, check roles).
 */
const trustedHeaderResolver: PrincipalResolver = {
  async resolve(req) {
    const id = req.header(env.TRUSTED_PRINCIPAL_HEADER)?.trim();
    if (!id) return null; // no identity asserted -> middleware applies AUTH_REQUIRED / default
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new ApiError(401, "authentication_error", "invalid principal id header");
    // Provision the principal on first sight so the business side doesn't have to pre-register users.
    const actor = (await principals.get(id)) ?? (await principals.upsert({ id, display_name: id }));
    const org = req.header("x-org-id")?.trim() || undefined;
    return { actor, owner: org };
  },
};
export default trustedHeaderResolver;
