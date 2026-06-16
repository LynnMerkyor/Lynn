export function notifyModelsChanged() {
  const platform = typeof window !== 'undefined' ? window.platform : undefined;
  platform?.settingsChanged?.('models-changed');
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('models-changed'));
  }
}
