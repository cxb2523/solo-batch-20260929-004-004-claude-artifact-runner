/**
 * End-to-end-ish simulation of the two manual acceptance scenarios:
 *   A) file name containing spaces against an existing normalized id
 *   B) case-only differing duplicate id
 * Both must be rejected with a notice and leave the list count unchanged.
 */
import assert from 'node:assert/strict';
import { validateArtifact } from '../src/lib/validate-artifact.ts';
import { RegistryStore, createMemoryStorage } from '../src/lib/registry-store.ts';

async function main(): Promise<void> {
  const store = new RegistryStore(createMemoryStorage());

  // Seed registry (mirrors registry-seed.ts).
  const seed = store.commit([
    { sourceFile: 'hello world.tsx', code: 'export default 1', baseVersion: 0, force: false },
    { sourceFile: 'sign_up form.tsx', code: 'export default 2', baseVersion: 0, force: false },
  ]);
  assert.equal(seed.ok, true);
  const initialCount = store.list().length;

  const validTsx = 'export default function X() { return <div />; }';

  // Scenario A: name with spaces collides with existing normalized key.
  const spaced = await validateArtifact('hello world.tsx', validTsx);
  assert.equal(spaced.ok, true);
  assert.equal(spaced.id, 'hello-world');
  const commitA = store.commit([
    {
      sourceFile: 'hello world.tsx',
      code: validTsx,
      baseVersion: store.get(spaced.id)?.version ?? 0,
      force: false,
    },
  ]);
  assert.equal(commitA.ok, false);
  if (!commitA.ok) {
    console.log(`[A 提示] ${commitA.failures[0].message}`);
    assert.equal(commitA.failures[0].reason, 'conflict');
  }
  assert.equal(store.list().length, initialCount, '清单条数必须不变');

  // Scenario B: case-only differing duplicate id.
  const cased = await validateArtifact('HELLO_WORLD.tsx', validTsx);
  assert.equal(cased.ok, true);
  assert.equal(cased.id, 'hello-world');
  const commitB = store.commit([
    {
      sourceFile: 'HELLO_WORLD.tsx',
      code: validTsx,
      baseVersion: store.get(cased.id)?.version ?? 0,
      force: false,
    },
  ]);
  assert.equal(commitB.ok, false);
  if (!commitB.ok) {
    console.log(`[B 提示] ${commitB.failures[0].message}`);
    assert.equal(commitB.failures[0].reason, 'conflict');
  }
  assert.equal(store.list().length, initialCount, '清单条数必须不变');

  console.log(`清单条数保持 ${initialCount} 条，两个场景均被拒绝`);
  console.log('acceptance smoke passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
