import { useCallback, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  FileWarning,
  GitBranch,
  History,
  Loader2,
  RefreshCcw,
  Trash2,
  UploadCloud,
} from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { validateArtifact, type ValidationResult } from '@/lib/validate-artifact';
import type { CommitFailure } from '@/lib/registry-store';
import { seedRegistryOnce } from '@/lib/registry-seed';
import { getRegistryStore, useRegistry } from '@/lib/use-registry';

/** Validated, queued draft. Nothing reaches here without passing static checks. */
interface QueueDraft {
  clientId: string;
  sourceFile: string;
  id: string;
  code: string;
  /** Registry version this draft was validated against. */
  baseVersion: number;
}

/** Rejected drop — shown red in place, never stored in the queue. */
interface RejectedFile {
  key: string;
  sourceFile: string;
  errors: ValidationResult['errors'];
}

type Notice =
  | { kind: 'success'; text: string }
  | { kind: 'error'; text: string };

let clientSeq = 0;
function nextClientId(): string {
  clientSeq += 1;
  return `draft-${Date.now()}-${clientSeq}`;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function describeFailures(failures: CommitFailure[]): string {
  return failures
    .map(
      (failure) =>
        `\n· ${failure.sourceFile}（id: ${failure.id}）— ${failure.message}`
    )
    .join('');
}

const store = getRegistryStore();
seedRegistryOnce(store);

export default function RegistryAdminPage() {
  const registry = useRegistry();
  const entries = useMemo(
    () => Object.values(registry.entries).sort((a, b) => a.id.localeCompare(b.id)),
    [registry.entries]
  );

  const [drafts, setDrafts] = useState<QueueDraft[]>([]);
  const [rejected, setRejected] = useState<RejectedFile[]>([]);
  const [force, setForce] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [validating, setValidating] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const versionMap = useMemo(() => {
    const map = new Map<string, number>();
    entries.forEach((entry) => map.set(entry.id, entry.version));
    return map;
  }, [entries]);

  const draftsWithFlags = useMemo(() => {
    const counts = new Map<string, number>();
    drafts.forEach((draft) => counts.set(draft.id, (counts.get(draft.id) ?? 0) + 1));
    return drafts.map((draft) => {
      const currentVersion = versionMap.get(draft.id);
      return {
        ...draft,
        duplicate: (counts.get(draft.id) ?? 0) > 1,
        conflict: currentVersion !== undefined,
        currentVersion: currentVersion ?? 0,
        stale: currentVersion !== undefined && draft.baseVersion !== currentVersion,
      };
    });
  }, [drafts, versionMap]);

  const hasBlockingRow = draftsWithFlags.some(
    (row) => row.duplicate || row.stale || (row.conflict && !force)
  );

  const ingestFiles = useCallback(async (files: File[]) => {
    const tsxFiles = files.filter((file) => /\.tsx$/i.test(file.name));
    const rejectedRows: RejectedFile[] = files
      .filter((file) => !/\.tsx$/i.test(file.name))
      .map((file) => ({
        key: nextClientId(),
        sourceFile: file.name,
        errors: [{ code: 'bad-extension' as const, message: '仅支持 .tsx 文件' }],
      }));

    if (tsxFiles.length === 0) {
      if (rejectedRows.length > 0) setRejected((prev) => [...prev, ...rejectedRows]);
      return;
    }

    setValidating(true);
    const accepted: QueueDraft[] = [];

    for (const file of tsxFiles) {
      const code = await file.text();
      const result = await validateArtifact(file.name, code);
      if (result.ok) {
        accepted.push({
          clientId: nextClientId(),
          sourceFile: file.name,
          id: result.id,
          code,
          baseVersion: store.get(result.id)?.version ?? 0,
        });
      } else {
        rejectedRows.push({
          key: nextClientId(),
          sourceFile: file.name,
          errors: result.errors,
        });
      }
    }

    setValidating(false);
    if (accepted.length > 0) setDrafts((prev) => [...prev, ...accepted]);
    if (rejectedRows.length > 0) setRejected((prev) => [...prev, ...rejectedRows]);
  }, []);

  const handleDrop = useCallback(
    async (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragging(false);
      setNotice(null);
      const files = Array.from(event.dataTransfer.files ?? []);
      if (files.length > 0) await ingestFiles(files);
    },
    [ingestFiles]
  );

  const handleSelectFiles = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      if (files.length > 0) await ingestFiles(files);
      event.target.value = '';
    },
    [ingestFiles]
  );

  const removeDraft = (clientId: string) => {
    setDrafts((prev) => prev.filter((draft) => draft.clientId !== clientId));
  };

  const dismissRejection = (key: string) => {
    setRejected((prev) => prev.filter((row) => row.key !== key));
  };

  const syncBaselines = useCallback(() => {
    setDrafts((prev) =>
      prev.map((draft) => ({
        ...draft,
        baseVersion: store.get(draft.id)?.version ?? 0,
      }))
    );
  }, []);

  const handleCommit = () => {
    if (drafts.length === 0 || hasBlockingRow) return;
    const result = store.commit(
      drafts.map((draft) => ({
        sourceFile: draft.sourceFile,
        code: draft.code,
        baseVersion: draft.baseVersion,
        force,
      }))
    );

    if (result.ok) {
      const overwritten = result.accepted.filter((a) => a.overwritten).length;
      setDrafts([]);
      setNotice({
        kind: 'success',
        text: `提交成功：新增 ${result.accepted.length - overwritten} 个，覆盖 ${overwritten} 个（覆盖可在顶部时间轴撤销）`,
      });
    } else {
      setNotice({
        kind: 'error',
        text: `整批回滚，未写入任何条目，草稿全部保留。${describeFailures(result.failures)}`,
      });
    }
  };

  const handleUndo = (eventId: string) => {
    if (store.undo(eventId)) {
      setNotice({ kind: 'success', text: '已撤销覆盖，恢复为上一版本' });
      syncBaselines();
    } else {
      setNotice({
        kind: 'error',
        text: '撤销失败：该条目在覆盖后又被修改，无法安全回滚',
      });
    }
  };

  return (
    <div className="min-h-screen bg-muted/40 px-4 py-8 sm:px-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <GitBranch className="h-6 w-6" />
            Artifact 注册表管理
          </h1>
          <p className="text-sm text-muted-foreground">
            拖入 .tsx → 静态校验（语法 + default 导出）→ 导入队列 → 批量提交。
            校验失败就地标红、不落库；同名冲突默认拒绝，勾选「强制覆盖」后可在时间轴撤销。
          </p>
        </header>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <History className="h-4 w-4" />
              覆盖时间轴
              <Badge variant="secondary">{registry.timeline.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {registry.timeline.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无覆盖记录。</p>
            ) : (
              <ScrollArea className="max-h-44">
                <ul className="space-y-2">
                  {[...registry.timeline].reverse().map((event) => (
                    <li
                      key={event.id}
                      className="flex items-center justify-between gap-3 rounded-md border bg-card px-3 py-2 text-sm"
                    >
                      <span className="flex items-center gap-2">
                        <span className="font-mono text-xs text-muted-foreground">
                          {formatTime(event.at)}
                        </span>
                        {event.label}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleUndo(event.id)}
                      >
                        撤销回上一版
                      </Button>
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            )}
          </CardContent>
        </Card>

        {notice && (
          <Alert variant={notice.kind === 'error' ? 'destructive' : 'default'}>
            {notice.kind === 'error' ? (
              <AlertCircle className="h-4 w-4" />
            ) : (
              <CheckCircle2 className="h-4 w-4" />
            )}
            <AlertDescription className="whitespace-pre-line">
              {notice.text}
            </AlertDescription>
          </Alert>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between text-base">
              <span className="flex items-center gap-2">
                <UploadCloud className="h-4 w-4" />
                导入队列
              </span>
              <Badge variant="secondary">{drafts.length} 个待提交</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div
              role="button"
              tabIndex={0}
              onClick={() => inputRef.current?.click()}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click();
              }}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors ${
                dragging
                  ? 'border-primary bg-primary/5'
                  : 'border-muted-foreground/30 hover:border-primary/60 hover:bg-accent'
              }`}
            >
              {validating ? (
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
              ) : (
                <UploadCloud className="h-8 w-8 text-muted-foreground" />
              )}
              <p className="text-sm font-medium">
                {validating
                  ? '正在做语法与 default 导出静态校验…'
                  : '拖入 .tsx 文件，或点击选择'}
              </p>
              <p className="text-xs text-muted-foreground">
                支持多文件、含空格或下划线的文件名；失败文件就地标红，不进入队列
              </p>
              <input
                ref={inputRef}
                type="file"
                accept=".tsx"
                multiple
                className="hidden"
                onChange={handleSelectFiles}
              />
            </div>

            {rejected.length > 0 && (
              <div className="space-y-2">
                {rejected.map((row) => (
                  <div
                    key={row.key}
                    className="flex items-start justify-between gap-3 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2"
                  >
                    <div className="flex items-start gap-2 text-sm">
                      <FileWarning className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                      <div>
                        <p className="font-medium text-destructive">{row.sourceFile}</p>
                        <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-xs text-destructive/90">
                          {row.errors.map((error, index) => (
                            <li key={index}>{error.message}</li>
                          ))}
                        </ul>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0 text-destructive"
                      onClick={() => dismissRejection(row.key)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {drafts.length > 0 && (
              <div className="space-y-3">
                <ScrollArea className="max-h-64 rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>来源文件名</TableHead>
                        <TableHead>注册表 id</TableHead>
                        <TableHead>基线</TableHead>
                        <TableHead>状态</TableHead>
                        <TableHead className="w-12" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {draftsWithFlags.map((row) => {
                        const blocked =
                          row.duplicate || row.stale || (row.conflict && !force);
                        return (
                          <TableRow
                            key={row.clientId}
                            className={blocked ? 'bg-destructive/5' : ''}
                          >
                            <TableCell className="font-mono text-xs">
                              {row.sourceFile}
                            </TableCell>
                            <TableCell className="font-mono text-xs">{row.id}</TableCell>
                            <TableCell className="font-mono text-xs">
                              v{row.baseVersion}
                            </TableCell>
                            <TableCell>
                              {row.stale ? (
                                <Badge variant="destructive" className="gap-1">
                                  <RefreshCcw className="h-3 w-3" />
                                  版本落后，当前 v{row.currentVersion}
                                </Badge>
                              ) : row.duplicate ? (
                                <Badge variant="destructive">批次内 id 重复</Badge>
                              ) : row.conflict ? (
                                <Badge
                                  variant={force ? 'outline' : 'destructive'}
                                  className="gap-1"
                                >
                                  <AlertCircle className="h-3 w-3" />
                                  {force
                                    ? `将强制覆盖 v${row.currentVersion}`
                                    : `冲突：id 已存在 v${row.currentVersion}`}
                                </Badge>
                              ) : (
                                <Badge variant="secondary">待新增</Badge>
                              )}
                            </TableCell>
                            <TableCell>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7"
                                onClick={() => removeDraft(row.clientId)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </ScrollArea>

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <Checkbox
                      checked={force}
                      onCheckedChange={(value) => setForce(value === true)}
                    />
                    强制覆盖同名条目
                  </label>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" onClick={syncBaselines}>
                      <RefreshCcw className="mr-1 h-4 w-4" />
                      刷新版本基线
                    </Button>
                    <Button onClick={handleCommit} disabled={hasBlockingRow}>
                      提交队列（{drafts.length}）
                    </Button>
                  </div>
                </div>
                {hasBlockingRow && (
                  <p className="text-xs text-destructive">
                    存在冲突、重复或版本落后的草稿：整批提交已禁用。解决冲突（勾选强制覆盖、去重或刷新基线）后再提交。
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between text-base">
              注册表清单
              <Badge variant="secondary">{entries.length} 条</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {entries.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                注册表为空，拖入第一个 .tsx 文件开始。
              </p>
            ) : (
              <ScrollArea className="max-h-[28rem] rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>id</TableHead>
                      <TableHead>来源文件名</TableHead>
                      <TableHead>规范文件名</TableHead>
                      <TableHead>版本</TableHead>
                      <TableHead>更新时间</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {entries.map((entry) => (
                      <TableRow key={entry.id}>
                        <TableCell className="font-mono text-xs font-medium">
                          {entry.id}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {entry.sourceFile}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {entry.canonicalFile}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">v{entry.version}</Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatTime(entry.updatedAt)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ScrollArea>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
