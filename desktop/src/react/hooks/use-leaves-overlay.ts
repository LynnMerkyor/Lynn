import { useSyncExternalStore } from 'react';

export const LEAVES_OVERLAY_STORAGE_KEY = 'hana-leaves-overlay';
const CHANGE_EVENT = 'lynn-leaves-overlay-changed';

function readPreference(): boolean {
  try {
    return localStorage.getItem(LEAVES_OVERLAY_STORAGE_KEY) !== '0';
  } catch {
    return false;
  }
}

export function setLeavesOverlayEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(LEAVES_OVERLAY_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    return;
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === LEAVES_OVERLAY_STORAGE_KEY || event.key === null) onChange();
  };
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener('storage', onStorage);
  };
}

export function useLeavesOverlayEnabled(): boolean {
  return useSyncExternalStore(subscribe, readPreference, () => true);
}
