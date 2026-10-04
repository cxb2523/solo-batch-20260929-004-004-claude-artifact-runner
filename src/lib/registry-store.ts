import { fileNameToId, idToFileName } from './slugify';

/** One registered artifact. */
export interface RegistryEntry {
  /** Canonical, normalized registry id (the CAS key). */
  id: string;
  /** Original source file name as supplied on import. */
  sourceFile: string;
  /** Canonical source file name derived from the id. */
  canonicalFile: string;
  /** Artifact source code. */
  code: string;
  /** Monotonic per-key version used for optimistic concurrency. */
  version: number;
  /** Creation timestamp (ms). */
  createdAt: number;
  /** Last update timestamp (ms). */
  updatedAt: number;
}

/** Timeline record kept for undo of forced overwrites. */
export interface TimelineEvent {
  id: string;
  at: number;
  idKey: string;
  label: string;
  kind: 'overwrite' | 'create';
  /** Snapshot of the entry replaced by the overwrite (needed to undo). */
  previous: RegistryEntry;
  /** Version produced by this event. */
  version: number;
}

export interface RegistryState {
  /** Keyed by canonical id, so lookups are case-insensitive. */
  entries: Record<string, RegistryEntry>;
  timeline: TimelineEvent[];
}

export interface CommitItem {
  sourceFile: string;
  code: string;
  /** Version the draft was based on; 0 means "must not exist yet". */
  baseVersion: number;
  /** When true an existing entry may be replaced. */
  force: boolean;
}

export interface CommitFailure {
  index: number;
  sourceFile: string;
  id: string;
  reason: 'conflict' | 'stale';
  message: string;
  currentVersion: number;
}

export type CommitResult =
  | { ok: true; accepted: Array<{ id: string; version: number; overwritten: boolean }> }
  | { ok: false; failures: CommitFailure[] };

/** Minimal storage surface so the store can run against localStorage or memory. */
export interface RegistryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = 'artifact-registry-v1';
const MAX_TIMELINE = 50;

function makeEventId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `evt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Append-only registry with optimistic concurrency control.
 *
 * Commits are batch-scoped: every item is preflighted against the current
 * state first, and the whole batch is rolled back (nothing is written) as
 * soon as any item conflicts or has a stale base version.
 */
export class RegistryStore {
  private state: RegistryState = { entries: {}, timeline: [] };
  private listeners = new Set<() => void>();

  constructor(private readonly storage: RegistryStorage | null = null) {
    this.state = this.load();
  }

  /** Subscribe to registry mutations (React bindings, tests). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }

  private load(): RegistryState {
    if (!this.storage) return { entries: {}, timeline: [] };
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return { entries: {}, timeline: [] };
      const parsed = JSON.parse(raw) as RegistryState;
      if (!parsed || typeof parsed !== 'object' || !parsed.entries) {
        return { entries: {}, timeline: [] };
      }
      return {
        entries: parsed.entries ?? {},
        timeline: Array.isArray(parsed.timeline) ? parsed.timeline : [],
      };
    } catch {
      return { entries: {}, timeline: [] };
    }
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // Storage may be full or blocked; the in-memory state stays authoritative.
    }
  }
  /** Read-only snapshot of the whole registry. */
  getState(): RegistryState {
    return this.state;
  }

  /** Lookup by id; id is normalized, so casing never matters. */
  get(id: string): RegistryEntry | undefined {
    return this.state.entries[fileNameToId(idToFileName(id))];
  }

  /** Lookup by original/canonical source file name (case-insensitive key). */
  getByFileName(fileName: string): RegistryEntry | undefined {
    return this.state.entries[fileNameToId(fileName)];
  }

  list(): RegistryEntry[] {
    return Object.values(this.state.entries).sort((a, b) =>
      a.id.localeCompare(b.id)
    );
  }

  /**
   * Commit a batch of draft artifacts atomically.
   *
   * Duplicate ids inside the same batch are treated as conflicts too.
   */
  commit(items: CommitItem[]): CommitResult {
    const failures: CommitFailure[] = [];
    const seen = new Map<string, number>();

    items.forEach((item, index) => {
      const id = fileNameToId(item.sourceFile);
      const existing = this.state.entries[id];

      if (seen.has(id)) {
        failures.push({
          index,
          sourceFile: item.sourceFile,
          id,
          reason: 'conflict',
          message: `与批次内第 ${seen.get(id)! + 1} 项重复（同一 id: ${id}）`,
          currentVersion: existing?.version ?? 0,
        });
        return;
      }
      seen.set(id, index);

      if (!existing) {
        if (item.baseVersion !== 0) {
          failures.push({
            index,
            sourceFile: item.sourceFile,
            id,
            reason: 'stale',
            message: '版本已落后：注册表中已不存在该条目，请刷新草稿基线',
            currentVersion: 0,
          });
        }
        return;
      }

      if (item.baseVersion !== existing.version) {
        failures.push({
          index,
          sourceFile: item.sourceFile,
          id,
          reason: 'stale',
          message: `版本号冲突：草稿基于 v${item.baseVersion}，当前为 v${existing.version}`,
          currentVersion: existing.version,
        });
        return;
      }

      if (!item.force) {
        failures.push({
          index,
          sourceFile: item.sourceFile,
          id,
          reason: 'conflict',
          message: `同名冲突：id "${id}" 已存在（v${existing.version}），勾选「强制覆盖」后才可替换`,
          currentVersion: existing.version,
        });
      }
    });

    if (failures.length > 0) {
      // Whole-batch rollback: nothing is written, caller keeps the drafts.
      return { ok: false, failures };
    }

    const now = Date.now();
    const accepted: Array<{ id: string; version: number; overwritten: boolean }> = [];

    for (const item of items) {
      const id = fileNameToId(item.sourceFile);
      const existing = this.state.entries[id];
      const overwritten = Boolean(existing);
      const version = (existing?.version ?? 0) + 1;

      if (existing) {
        this.state.timeline.push({
          id: makeEventId(),
          at: now,
          idKey: id,
          label: `覆盖 ${id}：v${existing.version} → v${version}`,
          kind: 'overwrite',
          previous: { ...existing },
          version,
        });
      }

      const entry: RegistryEntry = {
        id,
        sourceFile: item.sourceFile,
        canonicalFile: idToFileName(id),
        code: item.code,
        version,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      this.state.entries[id] = entry;
      accepted.push({ id, version, overwritten });
    }

    if (this.state.timeline.length > MAX_TIMELINE) {
      this.state.timeline = this.state.timeline.slice(-MAX_TIMELINE);
    }

    this.persist();
    this.emit();
    return { ok: true, accepted };
  }

  /**
   * Undo a timeline overwrite event: restore the previous version of the
   * entry. Returns false when the event no longer matches the registry.
   */
  undo(eventId: string): boolean {
    const eventIndex = this.state.timeline.findIndex((e) => e.id === eventId);
    if (eventIndex === -1) return false;
    const event = this.state.timeline[eventIndex];

    const current = this.state.entries[event.idKey];
    if (!current || current.version !== event.version) {
      // The entry moved on after this overwrite; do not clobber it.
      return false;
    }

    this.state.entries[event.idKey] = { ...event.previous };
    this.state.timeline = this.state.timeline.filter((e) => e.id !== eventId);
    this.persist();
    this.emit();
    return true;
  }

  /** Remove an entry (used by seeding/tests). */
  remove(id: string): boolean {
    const key = fileNameToId(idToFileName(id));
    if (!(key in this.state.entries)) return false;
    delete this.state.entries[key];
    this.persist();
    this.emit();
    return true;
  }
}

/** In-memory storage for tests and SSR-safe fallback. */
export function createMemoryStorage(initial?: string): RegistryStorage {
  let value = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
  };
}
