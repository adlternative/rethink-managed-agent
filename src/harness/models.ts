import { createModels, createProvider, type Model, type Models } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { env } from "../shared/env.ts";
import type { ModelRef } from "../shared/types.ts";

const QODER_MODEL_IDS = ["auto", "ultimate", "performance", "efficient", "lite", "cmodel", "kmodel", "gmodel", "qmodel"];

function qoderModels(): Model<"openai-completions">[] {
  return QODER_MODEL_IDS.map((id) => ({
    id,
    name: `qoder/${id}`,
    api: "openai-completions",
    provider: "qoder",
    baseUrl: env.QODER_BASE_URL,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: id === "ultimate" || id === "cmodel" ? 1_000_000 : 200_000,
    maxTokens: 32_000,
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
  }));
}

/** pi-ai Models with the qoder proxy (keyless, OpenAI-compatible) and, when configured, anthropic. */
export function createModelRegistry(): Models {
  const models = createModels();
  models.setProvider(
    createProvider({
      id: "qoder",
      name: "Qoder",
      baseUrl: env.QODER_BASE_URL,
      auth: { apiKey: { name: "Qoder", resolve: async () => ({ auth: {} }) } },
      models: qoderModels(),
      api: openAICompletionsApi(),
    }),
  );
  if (env.ANTHROPIC_API_KEY) models.setProvider(anthropicProvider());
  return models;
}

export function resolveModel(models: Models, ref: ModelRef): Model<any> {
  const model = models.getModel(ref.provider, ref.id);
  if (!model) {
    const known = models
      .getModels()
      .map((m) => `${m.provider}/${m.id}`)
      .join(", ");
    throw new Error(`Unknown model ${ref.provider}/${ref.id}. Known models: ${known || "(none)"}`);
  }
  return model;
}
