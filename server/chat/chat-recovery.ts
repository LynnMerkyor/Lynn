import { isBrainModelRef } from "../../shared/brain-provider.js";

interface ModelOverrides {
  provider?: string | null;
  id?: string | null;
  name?: string | null;
  api?: string | null;
}

interface EngineLike {
  resolveModelOverrides?: (model: ModelOverrides | null) => ModelOverrides | null;
  currentModel?: ModelOverrides | null;
}

interface ModelInfo {
  model: ModelOverrides | null;
  provider: string | null;
  modelId: string | null;
  modelName: string | null;
  api: string | null;
  isBrain: boolean;
}

export function resolveCurrentModelInfo(engine: EngineLike): ModelInfo {
  const model = engine.resolveModelOverrides?.(engine.currentModel ?? null) || engine.currentModel || null;
  return {
    model,
    provider: model?.provider || null,
    modelId: model?.id || null,
    modelName: model?.name || model?.id || null,
    api: model?.api || null,
    isBrain: isBrainModelRef(model?.id, model?.provider),
  };
}
