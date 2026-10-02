import assert from 'node:assert/strict';
import {
  keyFromFileName,
  sameKey,
  slugify,
  stripTsxExtension,
} from '../../src/lib/slugify';
import {
  countDefaultExports,
  findSyntaxError,
  validateArtifactFile,
  validateArtifactFileAsync,
} from '../../src/lib/artifact-validate';
import {
  REGISTRY_STORAGE_KEY,
  commitBatch,
  detectBatchConflicts,
  emptySnapshot,
  findEntryById,
  findEntryBySourceName,
  loadDrafts,
  loadSnapshot,
  makeDraft,
  memoryStore,
  saveDrafts,
  saveSnapshot,
  undoEvent,
  type DraftItem,
  type KeyValueStore,
  type RegistrySnapshot,
} from '../../src/lib/artifact-registry';

let passed = 0;
const tasks: Array<{ name: string; fn: () => void | Promise<void> }> = [];
function check(name: string, fn: () => void | Promise<void>): void {
  tasks.push({ name, fn });
}

const VALID_TSX = 'const A = () => null;\nexport default A;\n';
const uidFactory = (() => {
  let n = 0;
  return (prefix: string) => `${prefix}-${++n}`;
})();
const draft = (fileName: string, content = VALID_TSX): DraftItem =>
  makeDraft({ name: fileName, content }, uidFactory('d'), 1000);

// --- slugify ---------------------------------------------------------------

check('slugify: 小写化', () => {
  assert.equal(slugify('MyWidget'), 'mywidget');
});

check('slugify: 空白与下划线转连字符', () => {
  assert.equal(slugify('my widget'), 'my-widget');
  assert.equal(slugify('my_widget'), 'my-widget');
  assert.equal(slugify('my\t widget'), 'my-widget');
});

check('slugify: 折叠连续分隔符', () => {
  assert.equal(slugify('a__  --__b'), 'a-b');
  assert.equal(slugify('---a---'), 'a');
});

check('slugify: 去首尾空白与分隔符', () => {
  assert.equal(slugify('  -  x  -  '), 'x');
  assert.equal(slugify('___'), '');
});

check('slugify: 带空格/大小写/下划线文件名归一到同一 key', () => {
  assert.equal(keyFromFileName('My Widget.tsx'), 'my-widget');
  assert.equal(keyFromFileName('my_widget.TSX'), 'my-widget');
  assert.equal(keyFromFileName('MY-WIDGET.tsx'), 'my-widget');
  assert.equal(stripTsxExtension('x.TSX'), 'x');
});

check('slugify: sameKey 大小写与命名风格不敏感', () => {
  assert.ok(sameKey('My_Widget', 'my widget'));
  assert.ok(sameKey('MYWIDGET', 'mywidget'));
  assert.ok(!sameKey('a', 'b'));
});

// --- static validation -----------------------------------------------------

check('validate: 合法 tsx 通过', () => {
  const result = validateArtifactFile({ name: 'a.tsx', content: VALID_TSX });
  assert.ok(result.ok);
});

check('validate(async): 合法 JSX/模板/正则通过', async () => {
  const src = [
    'const r = /abc/g;',
    'const t = `a ${ { k: `n ${1}` }.k } b`;',
    'const Jsx = () => <div className="x">{r.test("z") && <span/>}</div>;',
    'export default Jsx;',
  ].join('\n');
  const result = await validateArtifactFileAsync({ name: 'jsx.tsx', content: src });
  assert.ok(result.ok);
});

check('validate(async): 捕获 JSX 语法错误', async () => {
  const result = await validateArtifactFileAsync({
    name: 'bad.tsx',
    content: 'function Broken( { return <div>\n; export default Broken;\n',
  });
  assert.ok(!result.ok);
  if (!result.ok) assert.equal(result.error.code, 'syntax');
});

check('validate: 非 tsx 被拒', () => {
  const result = validateArtifactFile({ name: 'a.jsx', content: VALID_TSX });
  assert.ok(!result.ok);
  if (!result.ok) assert.equal(result.error.code, 'not-tsx');
});

check('validate: 空文件/空 id 被拒', () => {
  const emptyFile = validateArtifactFile({ name: 'a.tsx', content: '   ' });
  assert.equal(emptyFile.ok, false);
  const emptyId = validateArtifactFile({ name: '---.tsx', content: VALID_TSX });
  assert.equal(emptyId.ok, false);
  if (!emptyId) assert.equal(emptyId.error.code, 'empty-id');
});

check('validate: 语法错误（未闭合括号/字符串/模板）', () => {
  assert.ok(findSyntaxError('const x = (1;\n') !== null);
  assert.ok(findSyntaxError("const s = 'unterminated;\n") !== null);
  assert.ok(findSyntaxError('const t = `unterminated;\n') !== null);
  assert.ok(findSyntaxError('const t = `${a`;\n') !== null);
  assert.ok(findSyntaxError('/* never ends') !== null);
  assert.equal(findSyntaxError('const x = [1, { a: 2 }, (3)];\n'), null);
});

check('validate: 扫描器支持嵌套模板/正则/自闭合 JSX', () => {
  const src = [
    'const r = /abc/g;',
    'const t = `a ${ { k: `n ${1}` }.k } b`;',
    'const Jsx = () => <div x={r.test("z") && <span/>} />;',
    'export default Jsx;',
  ].join('\n');
  assert.equal(findSyntaxError(src), null);
});

check('validate: 多行带属性/子节点/表达式的 JSX 组件通过', () => {
  const src = [
    'const Card = ({ title }) => (',
    '  <section className="card" data-id={`id-${1}`}>',
    '    <h1>{title || "untitled"}</h1>',
    '    {[1, 2].map((n) => <p key={n}>row {n}</p>)}',
    '  </section>',
    ');',
    'export default Card;',
  ].join('\n');
  assert.equal(findSyntaxError(src), null);
});

check('validate: JSX 标签未闭合被检出', () => {
  const src = 'const X = () => <div><span>hi</div>;\nexport default X;\n';
  assert.ok(findSyntaxError(src) !== null);
});

check('validate: 缺少 default 导出被拒', () => {
  const result = validateArtifactFile({
    name: 'a.tsx',
    content: 'export const A = 1;\n',
  });
  assert.ok(!result.ok);
  if (!result.ok) assert.equal(result.error.code, 'missing-default-export');
});

check('validate: 多个 default 导出被拒；type-only 导出不计入', () => {
  assert.equal(countDefaultExports('export type X = number;'), 0);
  const result = validateArtifactFile({
    name: 'a.tsx',
    content: 'export default 1;\nexport default 2;\n',
  });
  assert.ok(!result.ok);
  if (!result.ok) assert.equal(result.error.code, 'multiple-default-exports');
});

// --- registry: conflict, CAS, undo ----------------------------------------

function commitOnce(
  store: KeyValueStore,
  draftsToCommit: DraftItem[],
  opts: { force?: boolean } = {},
) {
  const before = loadSnapshot(store);
  const withForce = opts.force
    ? draftsToCommit.map((d) => ({ ...d, force: true }))
    : draftsToCommit;
  const result = commitBatch({
    snapshot: before,
    baseVersion: before.version,
    drafts: withForce,
    now: Date.now(),
  });
  if (result.ok) saveSnapshot(store, result.snapshot);
  return result;
}

check('registry: 正常提交落库且版本递增', () => {
  const store = memoryStore();
  const result = commitOnce(store, [draft('hello-world.tsx')]);
  assert.ok(result.ok);
  const snap = loadSnapshot(store);
  assert.equal(snap.version, 1);
  assert.equal(snap.entries.length, 1);
  assert.equal(snap.entries[0].id, 'hello-world');
});

check('registry: id↔文件名双向映射，大小写/空格/下划线等价', () => {
  const store = memoryStore();
  assert.ok(commitOnce(store, [draft('My Widget.tsx')]).ok);
  const snap = loadSnapshot(store);
  assert.ok(findEntryById(snap, 'MY-WIDGET'));
  assert.ok(findEntryById(snap, 'my_widget'));
  assert.ok(findEntryBySourceName(snap, 'my widget.TSX'));
});

check('registry: 仅大小写不同的重复 id 视为冲突并默认拒绝，条数不变', () => {
  const store = memoryStore();
  assert.ok(commitOnce(store, [draft('widget.tsx')]).ok);
  const before = loadSnapshot(store);
  assert.equal(before.entries.length, 1);

  const rejected = commitOnce(store, [draft('WIDGET.tsx')]);
  assert.ok(!rejected.ok);
  if (!rejected.ok) assert.equal(rejected.reason, 'conflicts');
  const after = loadSnapshot(store);
  assert.equal(after.version, 1);
  assert.equal(after.entries.length, 1);
  assert.equal(after.entries[0].id, 'widget');

  const conflicts = detectBatchConflicts(before, [draft('Widget.TSX')]);
  assert.ok(conflicts.some((c) => c.reasons.includes('existing-id')));
});

check('registry: 带空格/下划线的等价文件名同样冲突', () => {
  const store = memoryStore();
  assert.ok(commitOnce(store, [draft('my widget.tsx')]).ok);
  const result = commitOnce(store, [draft('my_widget.tsx')]);
  assert.ok(!result.ok);
  const snap = loadSnapshot(store);
  assert.equal(snap.entries.length, 1);
});

check('registry: 同批重复 id 即使强制也拒绝（整批回滚）', () => {
  const store = memoryStore();
  const result = commitOnce(
    store,
    [draft('a-file.tsx'), draft('A_File.tsx')],
    { force: true },
  );
  assert.ok(!result.ok);
  if (!result.ok) {
    assert.equal(result.reason, 'conflicts');
    assert.ok(result.conflicts?.some((c) => c.reasons.includes('batch-duplicate')));
  }
  assert.equal(loadSnapshot(store).entries.length, 0);
});

check('registry: 混合批次中一个冲突导致整批不落库', () => {
  const store = memoryStore();
  assert.ok(commitOnce(store, [draft('keep.tsx')]).ok);
  const result = commitOnce(store, [
    draft('new-one.tsx'),
    draft('KEEP.tsx'),
  ]);
  assert.ok(!result.ok);
  assert.equal(loadSnapshot(store).entries.length, 1);
});

check('registry: 强制覆盖替换条目并记录时间轴', () => {
  const store = memoryStore();
  assert.ok(commitOnce(store, [draft('widget.tsx', 'export default 1;\n')]).ok);
  const overwrite = commitOnce(
    store,
    [draft('WIDGET.tsx', 'export default 2;\n')],
    { force: true },
  );
  assert.ok(overwrite.ok);
  const snap = loadSnapshot(store);
  assert.equal(snap.entries.length, 1);
  assert.equal(snap.entries[0].revision, 2);
  assert.equal(snap.entries[0].content, 'export default 2;\n');
  assert.equal(snap.timeline.at(-1)?.action, 'overwrite');
});

check('registry: 撤销覆盖恢复上一版（id 与内容）', () => {
  const store = memoryStore();
  assert.ok(commitOnce(store, [draft('widget.tsx', 'export default 1;\n')]).ok);
  const overwrite = commitOnce(
    store,
    [draft('WIDGET.tsx', 'export default 2;\n')],
    { force: true },
  );
  assert.ok(overwrite.ok);
  const beforeUndo = loadSnapshot(store);
  const eventId = beforeUndo.timeline.at(-1)?.id as string;
  const undone = undoEvent(beforeUndo, beforeUndo.version, eventId);
  assert.ok(undone.ok);
  if (undone.ok) {
    saveSnapshot(store, undone.snapshot);
    assert.equal(undone.snapshot.entries.length, 1);
    assert.equal(undone.snapshot.entries[0].content, 'export default 1;\n');
    assert.equal(undone.snapshot.timeline.at(-1)?.action, 'undo');
  }
});

check('registry: 版本号 CAS 落后一方整批失败且不写入', () => {
  const store = memoryStore();
  const initial = emptySnapshot();
  const first = commitBatch({
    snapshot: initial,
    baseVersion: 0,
    drafts: [draft('first.tsx')],
  });
  assert.ok(first.ok);
  if (!first.ok) return;
  saveSnapshot(store, first.snapshot);

  // "Other tab" advanced v1 -> v2.
  const second = commitBatch({
    snapshot: first.snapshot,
    baseVersion: first.snapshot.version,
    drafts: [draft('second.tsx')],
  });
  assert.ok(second.ok);
  if (!second.ok) return;
  saveSnapshot(store, second.snapshot);

  // Stale committer still bases on v1.
  const stale = commitBatch({
    snapshot: second.snapshot,
    baseVersion: first.snapshot.version,
    drafts: [draft('stale.tsx')],
  });
  assert.ok(!stale.ok);
  if (!stale.ok) {
    assert.equal(stale.reason, 'stale-version');
    assert.equal(stale.current.version, 2);
  }
  const stored = loadSnapshot(store);
  assert.equal(stored.entries.length, 2);
  assert.ok(!stored.entries.some((e) => e.id === 'stale'));
});

check('registry: CAS 回滚后草稿仍保留在 draft store', () => {
  const store = memoryStore();
  const savedDrafts = [draft('stale-draft.tsx')];
  saveDrafts(store, savedDrafts);
  const server: RegistrySnapshot = { ...emptySnapshot(), version: 3 };
  const result = commitBatch({
    snapshot: server,
    baseVersion: 1,
    drafts: savedDrafts,
  });
  assert.ok(!result.ok);
  assert.deepEqual(loadDrafts(store).map((d) => d.id), ['stale-draft']);
});

check('registry: 损坏的持久化数据安全回退为空快照', () => {
  const store = memoryStore({ [REGISTRY_STORAGE_KEY]: '{not json' });
  const snap = loadSnapshot(store);
  assert.equal(snap.version, 0);
  assert.deepEqual(snap.entries, []);
});

async function main(): Promise<void> {
  for (const task of tasks) {
    await task.fn();
    passed += 1;
    console.log(`ok - ${task.name}`);
  }
  console.log(`\n${passed} checks passed`);
}

void main();
