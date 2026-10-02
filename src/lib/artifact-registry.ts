import {
  keyFromFileName,
  sameKey,
  slugify,
  stripTsxExtension,
} from './slugify';

export interface RegistryEntry {
  /** Normalized registry id — the single key on case-insensitive FS. */
  id: string;
  sourceFileName: string;
  content: string;
  size: number;
  importedAt: number;
  /** Bumped on every replacement of this entry. */
  revision: number;
}

export type TimelineAction = 'import' | 'overwrite' | 'undo';

export interface TimelineEvent {
  id: string;
  at: number;
  versionBefore: number;
  versionAfter: number;
  action: TimelineAction;
  /** Ids touched by the operation. */
  ids: string[];
  /** Full snapshot before the operation — used for undo. */
  before: RegistryEntry[];
  /** Human-readable summary. */
  note: string;
}

export interface RegistrySnapshot {
  version: number;
  entries: RegistryEntry[];
  timeline: TimelineEvent[];
  updatedAt: number;
}

export type DraftStatus = 'new' | 'conflict';

export interface DraftItem {
  /** Client-local unique id for React keys. */
  uid: string;
  fileName: string;
  /** Registry key derived from the file name. */
  id: string;
  content: string;
  size: number;
  addedAt: number;
  force: boolean;
}

export type ConflictReason =
  | 'empty-id'
  | 'batch-duplicate'
  | 'existing-id'
  | 'existing-source-name';

export interface BatchConflict {
  uid: string;
  id: string;
  fileName: string;
  reasons: ConflictReason[];
  /** Existing entry that would be replaced, when applicable. */
  existingId?: string;
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const REGISTRY_STORAGE_KEY = 'artifact-registry:v1';
export const DRAFT_STORAGE_KEY = 'artifact-registry:drafts:v1';

export function emptySnapshot(now = Date.now()): RegistrySnapshot {
  return { version: 0, entries: [], timeline: [], updatedAt: now };
}

export function loadSnapshot(store: KeyValueStore): RegistrySnapshot {
  const raw = store.getItem(REGISTRY_STORAGE_KEY);
  if (!raw) return emptySnapshot();
  try {
    const parsed = JSON.parse(raw) as RegistrySnapshot;
    if (!Array.isArray(parsed.entries) || typeof parsed.version !== 'number') {
      return emptySnapshot();
    }
    return {
      version: parsed.version,
      entries: parsed.entries,
      timeline: Array.isArray(parsed.timeline) ? parsed.timeline : [],
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
    };
  } catch {
    return emptySnapshot();
  }
}

/** Look up an entry by registry id (case-insensitive, normalized). */
export function findEntryById(
  snapshot: RegistrySnapshot,
  id: string,
): RegistryEntry | undefined {
  const key = slugify(id);
  return snapshot.entries.find((entry) => sameKey(entry.id, key));
}

/** Reverse lookup: source file name -> entry (same normalized key). */
export function findEntryBySourceName(
  snapshot: RegistrySnapshot,
  fileName: string,
): RegistryEntry | undefined {
  const key = keyFromFileName(fileName);
  return snapshot.entries.find((entry) =>
    sameKey(stripTsxExtension(entry.sourceFileName), key));
}

/**
 * Pure conflict detection for a prospective batch against a snapshot.
 * Never mutates anything.
 */
export function detectBatchConflicts(
  snapshot: RegistrySnapshot,
  drafts: DraftItem[],
): BatchConflict[] {
  const conflicts: BatchConflict[] = [];
  const seen = new Map<string, string>();

  for (const draft of drafts) {
    const reasons = new Set<ConflictReason>();
    const key = draft.id;

    if (!key) reasons.add('empty-id');

    if (key && seen.has(key)) reasons.add('batch-duplicate');
    else if (key) seen.set(key, draft.uid);

    const byId = key ? findEntryById(snapshot, key) : undefined;
    if (byId) {
      reasons.add('existing-id');
    }
    const byName = findEntryBySourceName(snapshot, draft.fileName);
    if (byName && (!byId || byId.id !== byName.id)) {
      reasons.add('existing-source-name');
    }

    if (reasons.size > 0) {
      conflicts.push({
        uid: draft.uid,
        id: key,
        fileName: draft.fileName,
        reasons: [...reasons],
        existingId: (byId ?? byName)?.id,
      });
    }
  }
  return conflicts;
}

export interface CommitInput {
  snapshot: RegistrySnapshot;
  /** Version the caller based its edits on. */
  baseVersion: number;
  drafts: DraftItem[];
  now?: number;
  eventId?: string;
}

export interface CommitOk {
  ok: true;
  snapshot: RegistrySnapshot;
  committed: DraftItem[];
  conflicts: BatchConflict[];
}

export interface CommitRejected {
  ok: false;
  reason: 'stale-version' | 'conflicts';
  /** Server-side snapshot at rejection time (for rebase). */
  current: RegistrySnapshot;
  conflicts?: BatchConflict[];
}

export type CommitResult = CommitOk | CommitRejected;

/**
 * CAS batch commit.
 *
 * - Version mismatch (another committer won) => whole batch rolls
 *   back; drafts are preserved by the caller.
 * - Same-name conflicts are rejected unless that specific draft
 *   opted into `force`.
 * - Duplicate keys inside the batch can never be forced.
 */
export function commitBatch(input: CommitInput): CommitResult {
  const { snapshot, baseVersion, drafts } = input;
  const now = input.now ?? Date.now();

  if (snapshot.version !== baseVersion) {
    return { ok: false, reason: 'stale-version', current: snapshot };
  }

  const allConflicts = detectBatchConflicts(snapshot, drafts);
  const blocking = allConflicts.filter((conflict) => {
    if (conflict.reasons.includes('batch-duplicate')
      || conflict.reasons.includes('empty-id')) {
      return true;
    }
    const draft = drafts.find((d) => d.uid === conflict.uid);
    return !draft?.force;
  });

  if (blocking.length > 0) {
    return {
      ok: false,
      reason: 'conflicts',
      current: snapshot,
      conflicts: allConflicts,
    };
  }

  const beforeEntries = snapshot.entries.map(cloneEntry);
  const entries = snapshot.entries.map(cloneEntry);
  const ids: string[] = [];
  let overwriteCount = 0;

  for (const draft of drafts) {
    const index = entries.findIndex((entry) => sameKey(entry.id, draft.id));
    if (index >= 0) {
      const previous = entries[index];
      entries[index] = {
        id: draft.id,
        sourceFileName: draft.fileName,
        content: draft.content,
        size: draft.size,
        importedAt: now,
        revision: previous.revision + 1,
      };
      overwriteCount += 1;
    } else {
      entries.push({
        id: draft.id,
        sourceFileName: draft.fileName,
        content: draft.content,
        size: draft.size,
        importedAt: now,
        revision: 1,
      });
    }
    ids.push(draft.id);
  }

  const event: TimelineEvent = {
    id: input.eventId ?? `evt-${now}-${Math.random().toString(36).slice(2, 8)}`,
    at: now,
    versionBefore: snapshot.version,
    versionAfter: snapshot.version + 1,
    action: overwriteCount > 0 ? 'overwrite' : 'import',
    ids,
    before: beforeEntries,
    note: overwriteCount > 0
      ? `提交 ${drafts.length} 项（强制覆盖 ${overwriteCount} 项）`
      : `提交 ${drafts.length} 项新制品`,
  };

  const next: RegistrySnapshot = {
    version: snapshot.version + 1,
    entries: entries.sort((a, b) => a.id.localeCompare(b.id)),
    timeline: [...snapshot.timeline, event],
    updatedAt: now,
  };

  return {
    ok: true,
    snapshot: next,
    committed: drafts,
    conflicts: allConflicts,
  };
}

/**
 * Restore the exact entry set recorded before a timeline event.
 * Bumps the version under CAS so concurrent undo/commit attempts
 * cannot silently clobber each other.
 */
export function undoEvent(
  snapshot: RegistrySnapshot,
  baseVersion: number,
  eventId: string,
  now = Date.now(),
): CommitResult & { event?: TimelineEvent } {
  if (snapshot.version !== baseVersion) {
    return { ok: false, reason: 'stale-version', current: snapshot };
  }
  const index = snapshot.timeline.findIndex((event) => event.id === eventId);
  if (index < 0) {
    return {
      ok: false,
      reason: 'conflicts',
      current: snapshot,
      conflicts: [],
    };
  }
  const event = snapshot.timeline[index];
  const restored = event.before.map(cloneEntry).sort((a, b) =>
    a.id.localeCompare(b.id));
  const nextEvent: TimelineEvent = {
    id: `evt-${now}-${Math.random().toString(36).slice(2, 8)}`,
    at: now,
    versionBefore: snapshot.version,
    versionAfter: snapshot.version + 1,
    action: 'undo',
    ids: event.ids,
    before: snapshot.entries.map(cloneEntry),
    note: `撤销：${event.note}`,
  };
  return {
    ok: true,
    snapshot: {
      version: snapshot.version + 1,
      entries: restored,
      timeline: [...snapshot.timeline, nextEvent],
      updatedAt: now,
    },
    committed: [],
    conflicts: [],
    event: nextEvent,
  };
}

function cloneEntry(entry: RegistryEntry): RegistryEntry {
  return { ...entry };
}

// --- Persisted draft queue ----------------------------------------------

export function loadDrafts(store: KeyValueStore): DraftItem[] {
  const raw = store.getItem(DRAFT_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as DraftItem[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item) => typeof item?.uid === 'string' && typeof item?.content === 'string',
    );
  } catch {
    return [];
  }
}

export function saveDrafts(store: KeyValueStore, drafts: DraftItem[]): void {
  store.setItem(DRAFT_STORAGE_KEY, JSON.stringify(drafts));
}

export function saveSnapshot(store: KeyValueStore, snapshot: RegistrySnapshot): void {
  store.setItem(REGISTRY_STORAGE_KEY, JSON.stringify(snapshot));
}

/** Build a draft from a validated file. */
export function makeDraft(
  file: { name: string; content: string },
  uid: string,
  now = Date.now(),
): DraftItem {
  return {
    uid,
    fileName: file.name,
    id: keyFromFileName(file.name),
    content: file.content,
    size: file.content.length,
    addedAt: now,
    force: false,
  };
}

/** In-memory KeyValueStore used by tests and as an SSR fallback. */
export function memoryStore(initial: Record<string, string> = {}): KeyValueStore {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key, value) => { map.set(key, value); },
  };
}
