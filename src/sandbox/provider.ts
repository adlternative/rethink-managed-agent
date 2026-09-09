import type { SandboxProvider, SandboxProviderName } from "../shared/types.ts";
import { LocalProvider } from "./local.ts";
import { DockerProvider } from "./docker.ts";
import { E2bProvider } from "./e2b.ts";

const providers: Record<SandboxProviderName, SandboxProvider> = {
  local: new LocalProvider(),
  docker: new DockerProvider(),
  e2b: new E2bProvider(),
};

export function getProvider(name: SandboxProviderName): SandboxProvider {
  const p = providers[name];
  if (!p) throw new Error(`unknown sandbox provider: ${name}`);
  return p;
}

export function allProviders(): SandboxProvider[] {
  return Object.values(providers);
}
