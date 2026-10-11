export function selectInstalledVisionModel(payload, { modelId = '', provider = '' } = {}) {
  const models = Array.isArray(payload?.models) ? payload.models : [];
  const targetId = String(modelId).trim();
  const targetProvider = String(provider).trim().toLowerCase();
  const explicit = Boolean(targetId || targetProvider);
  const candidates = models.filter(model => explicit
    ? (!targetId || model?.id === targetId)
      && (!targetProvider || String(model?.provider || '').toLowerCase() === targetProvider)
    : model?.isCurrent === true);
  if (candidates.length !== 1) {
    throw new Error(`[installed-gate] expected exactly one ${explicit ? 'explicitly selected' : 'current default'} vision-test model, found ${candidates.length}`);
  }
  const selected = candidates[0];
  if (!selected.id || !selected.provider) {
    throw new Error('[installed-gate] selected model is missing its provider or model ID');
  }
  if (selected.vision !== true) {
    throw new Error(`[installed-gate] selected model is not vision-capable: ${selected.provider}/${selected.id}`);
  }
  return selected;
}
