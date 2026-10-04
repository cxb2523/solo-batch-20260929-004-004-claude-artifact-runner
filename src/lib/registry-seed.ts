import demoIndexSource from '../artifacts/demo-index.txt?raw';
import demoSignupSource from '../artifacts/signup.tsx?raw';
import type { CommitItem } from './registry-store';
import type { RegistryStore } from './registry-store';

const SEED_FLAG = 'artifact-registry-seeded-v1';

/**
 * Seed the registry once per browser with the demo artifacts so the page is
 * useful (and testable) on first load. Never overwrites an existing registry.
 */
export function seedRegistryOnce(store: RegistryStore): void {
  if (typeof window === 'undefined') return;
  try {
    if (window.localStorage.getItem(SEED_FLAG)) return;
  } catch {
    return;
  }

  if (store.list().length === 0) {
    const items: CommitItem[] = [
      {
        sourceFile: 'hello world.tsx',
        code: demoIndexSource,
        baseVersion: 0,
        force: false,
      },
      {
        sourceFile: 'sign_up form.tsx',
        code: demoSignupSource,
        baseVersion: 0,
        force: false,
      },
    ];
    const result = store.commit(items);
    // Seed runs on an empty registry; accept even if timestamps collide.
    void result;
  }

  try {
    window.localStorage.setItem(SEED_FLAG, '1');
  } catch {
    // Ignore storage failures in seeding.
  }
}
