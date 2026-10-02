import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  CheckCircle2,
  CloudOff,
  FileCode2,
  Files,
  History,
  RefreshCw,
  ShieldAlert,
  Trash2,
  Undo2,
  UploadCloud,
  X,
} from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { validateArtifactFileAsync } from '@/lib/artifact-validate';
import {
  commitBatch,
  detectBatchConflicts,
  emptySnapshot,
  loadDrafts,
  loadSnapshot,
  makeDraft,
  memoryStore,
  saveDrafts,
  saveSnapshot,
  undoEvent,
  type BatchConflict,
  type DraftItem,
  type KeyValueStore,
  type RegistrySnapshot,
} from '@/lib/artifact-registry';

interface RejectedFile {
  uid: string;
  fileName: string;
  size: number;
  message: string;
  line?: number;
}

interface Toast {
  id: string;
  kind: 'success' | 'error' | 'info';
  text: string;
}

function browserStore(): KeyValueStore {
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage;
  }
  return memoryStore();
}

let uidCounter = 0;
function uid(prefix: string): string {
  uidCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${uidCounter}`;
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(at: number): string {
  return new Date(at).toLocaleString('zh-CN', { hour12: false });
}

const CONFLICT_LABEL: Record<string, string> = {
  'existing-id': 'id 已存在',
  'existing-source-name': '源文件名已存在',
  'batch-duplicate': '本批重复 id',
  'empty-id': 'id 为空',
};

export default function ArtifactRegistryPage() {
  const store = useRef<KeyValueStore>(browserStore());
  const [snapshot, setSnapshot] = useState<RegistrySnapshot>(() => emptySnapshot());
  const [baseVersion, setBaseVersion] = useState(0);
  const [drafts, setDrafts] = useState<DraftItem[]>([]);
  const [rejected, setRejected] = useState<RejectedFile[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [externalVersion, setExternalVersion] = useState<number | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const pushToast = useCallback((kind: Toast['kind'], text: string) => {
    const id = uid('toast');
    setToasts((prev) => [...prev.slice(-3), { id, kind, text }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((item) => item.id !== id));
    }, 4200);
  }, []);

  useEffect(() => {
    const loaded = loadSnapshot(store.current);
    setSnapshot(loaded);
    setBaseVersion(loaded.version);
    setDrafts(loadDrafts(store.current));
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === 'artifact-registry:v1' && event.newValue) {
        try {
          const next = JSON.parse(event.newValue) as RegistrySnapshot;
          if (typeof next.version === 'number' && next.version !== baseVersion) {
            setExternalVersion(next.version);
          }
        } catch {
          // Ignore malformed external writes.
        }
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [baseVersion]);

  const persistDrafts = useCallback((next: DraftItem[]) => {
    setDrafts(next);
    saveDrafts(store.current, next);
  }, []);

  const conflicts: BatchConflict[] = useMemo(
    () => detectBatchConflicts(snapshot, drafts),
    [snapshot, drafts],
  );
  const conflictByUid = useMemo(() => {
    const map = new Map<string, BatchConflict>();
    for (const conflict of conflicts) map.set(conflict.uid, conflict);
    return map;
  }, [conflicts]);

  const blockingCount = conflicts.filter((conflict) => {
    if (conflict.reasons.includes('batch-duplicate')
      || conflict.reasons.includes('empty-id')) {
      return true;
    }
    const draft = drafts.find((item) => item.uid === conflict.uid);
    return !draft?.force;
  }).length;

  const ingestFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;

    let accepted = 0;
    let failed = 0;
    const newDrafts: DraftItem[] = [];
    const newRejected: RejectedFile[] = [];

    for (const file of list) {
      const content = await file.text();
      const result = await validateArtifactFileAsync({ name: file.name, content });
      if (!result.ok) {
        failed += 1;
        newRejected.push({
          uid: uid('rej'),
          fileName: file.name,
          size: file.size,
          message: result.error.message,
          line: result.error.line,
        });
        continue;
      }
      accepted += 1;
      newDrafts.push(makeDraft({ name: file.name, content }, uid('draft')));
    }

    // Failed files never touch persistence or the draft list.
    if (newRejected.length > 0) {
      setRejected((prev) => [...newRejected, ...prev].slice(0, 50));
    }
    if (newDrafts.length > 0) {
      persistDrafts([...drafts, ...newDrafts]);
    }

    if (failed > 0 && accepted === 0) {
      pushToast('error', `${failed} 个文件静态校验失败，未写入注册表，清单与队列不留半成品`);
    } else if (failed > 0) {
      pushToast('info', `${accepted} 个已入队；${failed} 个校验失败已就地标红、不落库`);
    } else {
      pushToast('success', `${accepted} 个 .tsx 通过语法与默认导出校验，已进入导入队列`);
    }
  }, [drafts, persistDrafts, pushToast]);

  const handleDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (event.dataTransfer.files?.length) {
      void ingestFiles(event.dataTransfer.files);
    }
  }, [ingestFiles]);

  const handleCommit = useCallback(() => {
    if (drafts.length === 0 || busy) return;
    setBusy(true);
    setLastError(null);
    try {
      const result = commitBatch({ snapshot, baseVersion, drafts });
      if (!result.ok && result.reason === 'stale-version') {
        setExternalVersion(result.current.version);
        setLastError(
          `并发冲突：注册表已到 v${result.current.version}，本批基于 v${baseVersion}，整批已回滚，草稿保留`,
        );
        pushToast('error', '版本号 CAS 失败：整批回滚，导入草稿已保留');
        return;
      }
      if (!result.ok) {
        setLastError('存在同名/同 id 冲突：默认拒绝。请在冲突行勾选「强制覆盖」后重试，或移除重复项。');
        pushToast('error', '提交被拒绝：同名冲突默认不覆盖（清单条数不变）');
        return;
      }
      saveSnapshot(store.current, result.snapshot);
      setSnapshot(result.snapshot);
      setBaseVersion(result.snapshot.version);
      setExternalVersion(null);
      persistDrafts([]);
      pushToast('success', `已提交 ${result.committed.length} 项，注册表 v${result.snapshot.version}`);
    } finally {
      setBusy(false);
    }
  }, [busy, drafts, snapshot, baseVersion, persistDrafts, pushToast]);

  const handleUndo = useCallback((eventId: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = undoEvent(snapshot, baseVersion, eventId);
      if (!result.ok && result.reason === 'stale-version') {
        setExternalVersion(result.current.version);
        pushToast('error', '撤销失败：注册表已被其他提交更新，请先同步');
        return;
      }
      if (!result.ok) {
        pushToast('error', '撤销失败：找不到对应的时间轴记录');
        return;
      }
      saveSnapshot(store.current, result.snapshot);
      setSnapshot(result.snapshot);
      setBaseVersion(result.snapshot.version);
      pushToast('success', '已撤销到上一版（强制覆盖的条目已还原）');
    } finally {
      setBusy(false);
    }
  }, [busy, snapshot, baseVersion, pushToast]);

  const syncExternal = useCallback(() => {
    const fresh = loadSnapshot(store.current);
    setSnapshot(fresh);
    setBaseVersion(fresh.version);
    setExternalVersion(null);
    pushToast('info', `已同步到注册表 v${fresh.version}，可重新提交保留的草稿`);
  }, [pushToast]);

  // Deterministic "another tab wins" scenario for CAS verification.
  const simulateExternalCommit = useCallback(() => {
    const fresh = loadSnapshot(store.current);
    const externalDraft = makeDraft(
      {
        name: 'external-writer.tsx',
        content: 'const ExternalWriter = () => null;\nexport default ExternalWriter;\n',
      },
      uid('ext'),
      fresh.updatedAt,
    );
    const result = commitBatch({
      snapshot: fresh,
      baseVersion: fresh.version,
      drafts: [externalDraft],
      now: Date.now(),
    });
    if (!result.ok) {
      pushToast('info', '模拟写入未成功（id 已被占用），可先撤销再试');
      return;
    }
    saveSnapshot(store.current, result.snapshot);
    setExternalVersion(result.snapshot.version);
    pushToast('info', `模拟另一窗口已提交 v${result.snapshot.version}，当前页提交将触发 CAS 回滚`);
  }, [pushToast]);

  const toggleForce = (id: string, force: boolean) => {
    persistDrafts(drafts.map((draft) =>
      draft.uid === id ? { ...draft, force } : draft));
  };

  const removeDraft = (id: string) => {
    persistDrafts(drafts.filter((draft) => draft.uid !== id));
  };

  const dismissRejected = (id: string) => {
    setRejected((prev) => prev.filter((item) => item.uid !== id));
  };

  const timeline = [...snapshot.timeline].reverse();

  return (
    <div className="min-h-screen bg-muted/30">
      <div className="mx-auto max-w-6xl px-4 py-8 space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Files className="h-6 w-6" />
              制品注册表
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              拖入 <code className="rounded bg-muted px-1">.tsx</code> 制品 →
              静态校验 → 导入队列 → CAS 提交。同名冲突默认拒绝，强制覆盖可在时间轴撤销。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-sm">
              清单 {snapshot.entries.length} 条
            </Badge>
            <Badge variant="secondary" className="text-sm">
              注册表 v{snapshot.version}
            </Badge>
            <Button
              variant="ghost"
              size="sm"
              onClick={simulateExternalCommit}
              title="模拟另一个窗口先提交，用于验证同 key 并发 CAS 回滚"
            >
              <CloudOff className="h-4 w-4 mr-1" />
              模拟并发写入
            </Button>
          </div>
        </header>

        {externalVersion !== null && externalVersion !== baseVersion && (
          <Alert variant="destructive">
            <ShieldAlert className="h-4 w-4" />
            <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
              <span>
                检测到其他窗口已把注册表更新到 v{externalVersion}，当前页基于
                v{baseVersion}。直接提交将整批回滚并保留草稿。
              </span>
              <Button size="sm" variant="outline" onClick={syncExternal}>
                <RefreshCw className="h-4 w-4 mr-1" />
                立即同步
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {lastError && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="flex items-start justify-between gap-2">
              <span>{lastError}</span>
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6 shrink-0"
                onClick={() => setLastError(null)}
                aria-label="关闭提示"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </AlertDescription>
          </Alert>
        )}

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <History className="h-4 w-4" />
              顶部时间轴
            </CardTitle>
            <CardDescription>
              每次强制覆盖都会保留上一版快照，可随时撤销回去。
            </CardDescription>
          </CardHeader>
          <CardContent>
            {timeline.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无提交记录。</p>
            ) : (
              <ol className="relative border-l border-border space-y-3 pl-4">
                {timeline.map((event, index) => (
                  <li key={event.id} className="relative">
                    <span
                      className={`absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full ${
                        event.action === 'undo'
                          ? 'bg-muted-foreground'
                          : event.action === 'overwrite'
                            ? 'bg-amber-500'
                            : 'bg-emerald-500'
                      }`}
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{event.note}</span>
                      <Badge
                        variant={event.action === 'overwrite' ? 'destructive' : 'secondary'}
                      >
                        v{event.versionBefore} → v{event.versionAfter}
                      </Badge>
                      {index === timeline.length - 1 && event.action !== 'undo' && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => handleUndo(event.id)}
                        >
                          <Undo2 className="h-3.5 w-3.5 mr-1" />
                          撤销回上一版
                        </Button>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {formatTime(event.at)} · {event.ids.join(', ')}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">导入队列</CardTitle>
            <CardDescription>
              先做语法与默认导出静态校验，通过的文件才会进入队列并暂存草稿；失败就地标红、绝不落库。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div
              role="button"
              tabIndex={0}
              onClick={() => inputRef.current?.click()}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click();
              }}
              onDragEnter={(event) => {
                event.preventDefault();
                dragDepth.current += 1;
                setDragging(true);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => {
                event.preventDefault();
                dragDepth.current -= 1;
                if (dragDepth.current <= 0) setDragging(false);
              }}
              onDrop={handleDrop}
              className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors ${
                dragging
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-primary/50 hover:bg-muted/50'
              }`}
            >
              <UploadCloud className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm font-medium">
                拖放一个或多个 <span className="font-mono">.tsx</span> 文件到此处
              </p>
              <p className="text-xs text-muted-foreground">或点击选择文件；文件名即注册表 id 的来源</p>
              <input
                ref={inputRef}
                type="file"
                accept=".tsx"
                multiple
                className="hidden"
                onChange={(event) => {
                  if (event.target.files) void ingestFiles(event.target.files);
                  event.target.value = '';
                }}
              />
            </div>

            {rejected.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-destructive flex items-center gap-1">
                  <AlertTriangle className="h-4 w-4" />
                  校验失败（未入队、未入库）
                </p>
                <ul className="space-y-2">
                  {rejected.map((item) => (
                    <li
                      key={item.uid}
                      className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 text-sm font-medium text-destructive">
                          <FileCode2 className="h-4 w-4 shrink-0" />
                          <span className="truncate">{item.fileName}</span>
                          <span className="text-xs font-normal text-muted-foreground">
                            {formatSize(item.size)}
                          </span>
                        </p>
                        <p className="mt-0.5 text-xs text-destructive/90">
                          {item.message}
                          {item.line ? `（第 ${item.line} 行）` : ''}
                        </p>
                      </div>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 shrink-0 text-destructive"
                        onClick={() => dismissRejected(item.uid)}
                        aria-label={`移除失败记录 ${item.fileName}`}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {drafts.length > 0 ? (
              <div className="space-y-2">
                <ul className="divide-y divide-border rounded-md border">
                  {drafts.map((draft) => {
                    const conflict = conflictByUid.get(draft.uid);
                    const hardConflict = conflict?.reasons.some(
                      (reason) => reason === 'batch-duplicate' || reason === 'empty-id',
                    );
                    return (
                      <li
                        key={draft.uid}
                        className={`flex flex-wrap items-center gap-3 px-3 py-2.5 ${
                          conflict ? 'bg-amber-50 dark:bg-amber-950/20' : ''
                        }`}
                      >
                        <FileCode2 className={`h-4 w-4 shrink-0 ${
                          conflict ? 'text-amber-600' : 'text-muted-foreground'
                        }`} />
                        <div className="min-w-[10rem] flex-1">
                          <p className="truncate text-sm font-medium">{draft.fileName}</p>
                          <p className="text-xs text-muted-foreground">
                            id: <code>{draft.id || '(空)'}</code> · {formatSize(draft.size)}
                          </p>
                        </div>
                        {conflict && (
                          <div className="flex flex-wrap items-center gap-1">
                            {conflict.reasons.map((reason) => (
                              <Badge
                                key={reason}
                                variant={hardConflict ? 'destructive' : 'outline'}
                                className="gap-1 border-amber-500 text-amber-700 dark:text-amber-400"
                              >
                                <AlertTriangle className="h-3 w-3" />
                                {CONFLICT_LABEL[reason] ?? reason}
                                {conflict.existingId && reason === 'existing-id'
                                  ? `：${conflict.existingId}`
                                  : ''}
                              </Badge>
                            ))}
                          </div>
                        )}
                        {conflict && !hardConflict && (
                          <label className="flex items-center gap-1.5 text-xs font-medium">
                            <Checkbox
                              checked={draft.force}
                              onCheckedChange={(value) =>
                                toggleForce(draft.uid, Boolean(value))}
                            />
                            强制覆盖
                          </label>
                        )}
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 shrink-0"
                          onClick={() => removeDraft(draft.uid)}
                          aria-label={`移除草稿 ${draft.fileName}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </li>
                    );
                  })}
                </ul>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    队列 {drafts.length} 项
                    {blockingCount > 0 ? ` · ${blockingCount} 项冲突待处理（默认拒绝覆盖）` : ''}
                  </p>
                  <Button
                    onClick={handleCommit}
                    disabled={busy || blockingCount > 0}
                    title={blockingCount > 0 ? '存在未处理冲突，提交将整批拒绝' : '按版本号 CAS 整批提交'}
                  >
                    <CheckCircle2 className="h-4 w-4 mr-1" />
                    提交队列（CAS v{baseVersion}）
                  </Button>
                </div>
              </div>
            ) : (
              rejected.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  队列为空。通过校验的 .tsx 会作为草稿暂存，提交失败时草稿保留。
                </p>
              )
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              已注册制品（{snapshot.entries.length}）
            </CardTitle>
            <CardDescription>
              注册表 id 与来源文件名经 slugify 双向映射，大小写不敏感文件系统视为同一 key。
            </CardDescription>
          </CardHeader>
          <CardContent>
            {snapshot.entries.length === 0 ? (
              <p className="text-sm text-muted-foreground">注册表为空。</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">id / 路由</th>
                      <th className="py-2 pr-3 font-medium">来源文件</th>
                      <th className="py-2 pr-3 font-medium">版本</th>
                      <th className="py-2 pr-3 font-medium">大小</th>
                      <th className="py-2 font-medium">导入时间</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {snapshot.entries.map((entry) => (
                      <tr key={entry.id}>
                        <td className="py-2 pr-3">
                          <Link
                            to={`/${encodeURIComponent(entry.id)}`}
                            target="_blank"
                            rel="noreferrer"
                            className="font-mono text-primary hover:underline"
                          >
                            /{entry.id}
                          </Link>
                        </td>
                        <td className="py-2 pr-3 font-mono text-xs">{entry.sourceFileName}</td>
                        <td className="py-2 pr-3">
                          <Badge variant="secondary">rev {entry.revision}</Badge>
                        </td>
                        <td className="py-2 pr-3 text-xs text-muted-foreground">
                          {formatSize(entry.size)}
                        </td>
                        <td className="py-2 text-xs text-muted-foreground">
                          {formatTime(entry.importedAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-3 text-xs text-muted-foreground">
              需要演示页面？前往 <Link to="/signup" className="text-primary hover:underline">/signup</Link>。
            </p>
          </CardContent>
        </Card>

        {/* Toasts */}
        <div className="fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              role="status"
              className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm shadow-md ${
                toast.kind === 'error'
                  ? 'border-destructive/50 bg-destructive text-destructive-foreground'
                  : toast.kind === 'success'
                    ? 'border-emerald-500/50 bg-emerald-50 text-emerald-900'
                    : 'border-border bg-popover text-popover-foreground'
              }`}
            >
              {toast.kind === 'error' ? (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              ) : toast.kind === 'success' ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
              ) : (
                <RefreshCw className="mt-0.5 h-4 w-4 shrink-0" />
              )}
              <span className="flex-1">{toast.text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
