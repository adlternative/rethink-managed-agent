import type { SandboxProvider, SandboxProviderName } from "../shared/types.ts";
import { LocalProvider } from "./local.ts";
import { DockerProvider } from "./docker.ts";
import { E2bProvider } from "./e2b.ts";
import { ByocProvider } from "./byoc.ts";
import { SandboxManager } from "./manager.ts";

const providers: Record<SandboxProviderName, SandboxProvider> = {
  local: new LocalProvider(),
  docker: new DockerProvider(),
  e2b: new E2bProvider(),
  byoc: new ByocProvider(),
};

/** Process-wide manager; providers are stateless apart from live handles the manager holds. */
export const sandboxManager = new SandboxManager(providers);

export function getProvider(name: SandboxProviderName): SandboxProvider {
  return sandboxManager.provider(name);
}
