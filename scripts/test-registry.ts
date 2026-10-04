import assert from 'node:assert/strict';
import {
  slugify,
  fileNameToId,
  idToFileName,
  stripArtifactExt,
} from '../src/lib/slugify.ts';
import { validateArtifact } from '../src/lib/validate-artifact.ts';
import { RegistryStore, createMemoryStorage } from '../src/lib/registry-store.ts';

type TestFn = () => void | Promise<void>;
const queue: Array<{ name: string; fn: TestFn }> = [];

function test(name: string, fn: TestFn): void {
  queue.push({ name, fn });
}

// --- slugify ----------------------------------------------------------------

test('lowercases input', () => {
  assert.equal(slugify('HelloWorld'), 'helloworld');
});

test('whitespace and underscores become hyphens', () => {
  assert.equal(slugify('hello world_foo'), 'hello-world-foo');
});

test('collapses consecutive separators', () => {
  assert.equal(slugify('a  b___c---d'), 'a-b-c-d');
});

test('trims leading and trailing separators', () => {
  assert.equal(slugify('  --hello--  '), 'hello');
  assert.equal(slugify('___'), '');
});

test('spaces inside file names normalize to a single-key id', () => {
  assert.equal(fileNameToId('Hello World.tsx'), 'hello-world');
});

test('id <-> file name mapping is bijective on the normalized key space', () => {
  for (const id of ['Hello World', 'sign_up form', 'My-Artifact']) {
    assert.equal(fileNameToId(idToFileName(id)), slugify(id));
  }
});

test('case-only differing file names share the same key', () => {
  assert.equal(fileNameToId('MyWidget.tsx'), fileNameToId('mywidget.TSX'));
  assert.equal(stripArtifactExt('Data.TSX'), 'Data');
});

// --- validateArtifact -------------------------------------------------------

test('rejects non-.tsx files', async () => {
  const result = await validateArtifact('notes.txt', 'export default 1');
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'bad-extension'));
});

test('rejects file names that normalize to an empty id', async () => {
  const result = await validateArtifact(
    '___.tsx',
    'export default function A() { return null; }'
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'empty-id'));
});

test('rejects syntax errors', async () => {
  const result = await validateArtifact(
    'broken.tsx',
    'export default function Broken( { return <div>;'
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'syntax-error'));
});

test('rejects missing default export', async () => {
  const result = await validateArtifact(
    'named-only.tsx',
    'export const Named = () => <div />;'
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'missing-default-export'));
});

for (const [label, code] of [
  ['declaration', 'export default function App() { return <div />; }'],
  ['named binding', 'function App() { return <div />; } export default App;'],
  ['renamed specifier', 'function App() { return <div />; } export { App as default };'],
] as const) {
  test(`accepts default export shape: ${label}`, async () => {
    const result = await validateArtifact('app.tsx', code);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.id, 'app');
  });
}

// --- RegistryStore ----------------------------------------------------------

test('commits new entries at v1 and maps both lookup directions', () => {
  const store = new RegistryStore(createMemoryStorage());
  const result = store.commit([
    { sourceFile: 'my widget.tsx', code: 'export default 1', baseVersion: 0, force: false },
  ]);
  assert.equal(result.ok, true);
  assert.equal(store.list().length, 1);
  assert.equal(store.get('My Widget')?.version, 1);
  assert.equal(store.getByFileName('MY WIDGET.TSX')?.canonicalFile, 'my-widget.tsx');
});

test('rejects same-name conflict without force and keeps the registry intact', () => {
  const store = new RegistryStore(createMemoryStorage());
  store.commit([
    { sourceFile: 'widget.tsx', code: 'a', baseVersion: 0, force: false },
  ]);
  const result = store.commit([
    { sourceFile: 'Widget.tsx', code: 'b', baseVersion: 1, force: false },
  ]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.failures[0].reason, 'conflict');
  assert.equal(store.list().length, 1);
  assert.equal(store.get('widget')?.code, 'a');
});

test('case-only differing ids are the same key (case-insensitive FS)', () => {
  const store = new RegistryStore(createMemoryStorage());
  store.commit([
    { sourceFile: 'DataCard.tsx', code: 'a', baseVersion: 0, force: false },
  ]);
  const result = store.commit([
    { sourceFile: 'datacard.tsx', code: 'b', baseVersion: 1, force: false },
  ]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.failures[0].reason, 'conflict');
  assert.equal(store.list().length, 1);
});

test('forced overwrite bumps version and is undoable from the timeline', () => {
  const store = new RegistryStore(createMemoryStorage());
  store.commit([
    { sourceFile: 'widget.tsx', code: 'v1', baseVersion: 0, force: false },
  ]);
  const overwrite = store.commit([
    { sourceFile: 'widget.tsx', code: 'v2', baseVersion: 1, force: true },
  ]);
  assert.equal(overwrite.ok, true);
  assert.equal(store.get('widget')?.version, 2);
  assert.equal(store.getState().timeline.length, 1);

  const eventId = store.getState().timeline[0].id;
  assert.equal(store.undo(eventId), true);
  assert.equal(store.get('widget')?.code, 'v1');
  assert.equal(store.get('widget')?.version, 1);
  assert.equal(store.getState().timeline.length, 0);
});

test('stale CAS base rolls back the WHOLE batch (new entry excluded too)', () => {
  const store = new RegistryStore(createMemoryStorage());
  store.commit([
    { sourceFile: 'widget.tsx', code: 'v1', baseVersion: 0, force: false },
    { sourceFile: 'other.tsx', code: 'a', baseVersion: 0, force: false },
  ]);
  store.commit([
    { sourceFile: 'widget.tsx', code: 'v2', baseVersion: 1, force: true },
  ]);

  // Lagging batch: widget based on stale v1, plus a brand-new entry.
  const lagging = store.commit([
    { sourceFile: 'widget.tsx', code: 'stale', baseVersion: 1, force: true },
    { sourceFile: 'brand-new.tsx', code: 'x', baseVersion: 0, force: false },
  ]);
  assert.equal(lagging.ok, false);
  if (!lagging.ok) assert.equal(lagging.failures[0].reason, 'stale');
  assert.equal(store.get('widget')?.code, 'v2');
  assert.equal(store.get('brand-new'), undefined);
  assert.equal(store.list().length, 2);
});

test('duplicate ids inside one batch are rejected atomically', () => {
  const store = new RegistryStore(createMemoryStorage());
  const result = store.commit([
    { sourceFile: 'My Widget.tsx', code: 'a', baseVersion: 0, force: false },
    { sourceFile: 'my_widget.tsx', code: 'b', baseVersion: 0, force: false },
  ]);
  assert.equal(result.ok, false);
  assert.equal(store.list().length, 0);
});

test('persists across store instances via storage', () => {
  const memory = createMemoryStorage();
  new RegistryStore(memory).commit([
    { sourceFile: 'persist.tsx', code: 'a', baseVersion: 0, force: false },
  ]);
  assert.equal(new RegistryStore(memory).get('persist')?.version, 1);
});

// --- runner -----------------------------------------------------------------

async function main(): Promise<void> {
  let failures = 0;
  for (const { name, fn } of queue) {
    try {
      await fn();
      console.log(`  ok - ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`  FAIL - ${name}`);
      console.error(error);
    }
  }
  const passed = queue.length - failures;
  console.log(`\n${passed}/${queue.length} checks passed`);
  if (failures > 0) {
    console.error('registry tests FAILED');
    process.exit(1);
  }
  console.log('registry tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
