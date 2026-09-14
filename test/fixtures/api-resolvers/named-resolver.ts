/** A PRINCIPAL_RESOLVER module exporting a named `resolver` (accepted as an alternative to a default export). */
export const resolver = {
  async resolve() { return { actor: { id: "prc_named", kind: "user" as const, handle: null, display_name: "named", created_at: "" } }; },
};
