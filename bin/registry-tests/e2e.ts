import assert from 'node:assert/strict';
import { validateArtifactFileAsync } from '../../src/lib/artifact-validate';
import {
  commitBatch,
  loadSnapshot,
  makeDraft,
  memoryStore,
  saveSnapshot,
  undoEvent,
  type KeyValueStore,
} from '../../src/lib/artifact-registry';

let counter = 0;
const uid = () => `d-${++counter}`;
const tsx = (body = 'export default function C() { return null; }\n') => body;

async function main(): Promise<void> {
  const store: KeyValueStore = memoryStore();

  // 1. File name with spaces: valid, normalized id uses hyphens.
  const spaced = await validateArtifactFileAsync({
    name: 'my cool widget.tsx',
    content: tsx(),
  });
  assert.ok(spaced.ok, 'spaced file passes static validation');
  const spacedDraft = makeDraft(
    { name: 'my cool widget.tsx', content: tsx() },
    uid(),
  );
  assert.equal(spacedDraft.id, 'my-cool-widget');

  const first = commitBatch({
    snapshot: loadSnapshot(store),
    baseVersion: 0,
    drafts: [spacedDraft],
  });
  assert.ok(first.ok);
  if (first.ok) saveSnapshot(store, first.snapshot);
  assert.equal(loadSnapshot(store).entries.length, 1);

  // 2. Case-only duplicate id: rejected by default, count unchanged.
  const upper = await validateArtifactFileAsync({
    name: 'MY COOL WIDGET.tsx',
    content: tsx('export default function C2() { return null; }\n'),
  });
  assert.ok(upper.ok, 'static validation itself passes');
  const conflictDraft = makeDraft(
    { name: 'MY COOL WIDGET.tsx', content: tsx('export default function C2() {}') },
    uid(),
  );

  const rejected = commitBatch({
    snapshot: loadSnapshot(store),
    baseVersion: loadSnapshot(store).version,
    drafts: [conflictDraft],
  });
  assert.ok(!rejected.ok);
  if (!rejected.ok) assert.equal(rejected.reason, 'conflicts');
  assert.equal(loadSnapshot(store).entries.length, 1, 'list length unchanged');

  // 3. Force overwrite replaces, then timeline undo restores.
  const forced = commitBatch({
    snapshot: loadSnapshot(store),
    baseVersion: loadSnapshot(store).version,
    drafts: [{ ...conflictDraft, force: true }],
  });
  assert.ok(forced.ok);
  if (forced.ok) saveSnapshot(store, forced.snapshot);
  const overwritten = loadSnapshot(store);
  assert.equal(overwritten.entries.length, 1);
  assert.equal(overwritten.entries[0].revision, 2);
  assert.match(overwritten.entries[0].content, /C2/);

  const eventId = overwritten.timeline.at(-1)?.id as string;
  const undone = undoEvent(overwritten, overwritten.version, eventId);
  assert.ok(undone.ok);
  if (undone.ok) {
    saveSnapshot(store, undone.snapshot);
    assert.equal(undone.snapshot.entries[0].revision, 1);
    assert.doesNotMatch(undone.snapshot.entries[0].content, /C2/);
  }

  // 4. CAS: stale base rolls the whole batch back.
  const current = loadSnapshot(store);
  const otherWriter = commitBatch({
    snapshot: current,
    baseVersion: current.version,
    drafts: [makeDraft({ name: 'other.tsx', content: tsx() }, uid())],
  });
  assert.ok(otherWriter.ok);
  if (otherWriter.ok) saveSnapshot(store, otherWriter.snapshot);

  const stale = commitBatch({
    snapshot: loadSnapshot(store),
    baseVersion: current.version,
    drafts: [makeDraft({ name: 'late.tsx', content: tsx() }, uid())],
  });
  assert.ok(!stale.ok);
  if (!stale.ok) assert.equal(stale.reason, 'stale-version');
  assert.equal(loadSnapshot(store).entries.length, 2);

  // 5. Invalid syntax never produces a draft candidate id pair.
  const bad = await validateArtifactFileAsync({
    name: 'broken.tsx',
    content: 'export const x = (1;\n',
  });
  assert.ok(!bad.ok);

  console.log('e2e: all scenarios passed');
}

void main();
