import { isBrainModelRef } from "../../shared/brain-provider.js";

export function resolveCurrentModelInfo(engine) {
  const model = engine.resolveModelOverrides?.(engine.currentModel) || engine.currentModel || null;
  return {
    model,
    provider: model?.provider || null,
    modelId: model?.id || null,
    modelName: model?.name || model?.id || null,
    api: model?.api || null,
    isBrain: isBrainModelRef(model?.id, model?.provider),
  };
}
