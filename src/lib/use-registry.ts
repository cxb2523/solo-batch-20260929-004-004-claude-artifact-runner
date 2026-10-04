import { useSyncExternalStore } from 'react';
import { RegistryStore, type RegistryState } from './registry-store';

let storeSingleton: RegistryStore | null = null;

function getStore(): RegistryStore {
  if (!storeSingleton) {
    const storage =
      typeof window !== 'undefined' && window.localStorage
        ? window.localStorage
        : null;
    storeSingleton = new RegistryStore(storage);
  }
  return storeSingleton;
}

/** Shared registry instance (localStorage-backed in the browser). */
export function getRegistryStore(): RegistryStore {
  return getStore();
}

/** Subscribe to registry state snapshots. */
export function useRegistry(): RegistryState {
  const store = getStore();
  return useSyncExternalStore(
    (onChange) => store.subscribe(onChange),
    () => store.getState()
  );
}
