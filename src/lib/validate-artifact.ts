import { isArtifactFile, fileNameToId } from './slugify';

export type ValidationCode =
  | 'bad-extension'
  | 'empty-id'
  | 'syntax-error'
  | 'missing-default-export';

export interface ValidationResult {
  ok: boolean;
  id: string;
  errors: Array<{ code: ValidationCode; message: string }>;
}

/**
 * Statically validate a dropped .tsx artifact BEFORE it enters the queue or
 * touches storage:
 *   1. extension must be .tsx
 *   2. normalized id must be non-empty
 *   3. source must parse as TS/TSX (syntax only, no type checking)
 *   4. source must contain a default export (declaration, named list or
 *      `export default ...`)
 *
 * TypeScript is loaded lazily so the registry page stays light until a file
 * is actually dropped.
 */
export async function validateArtifact(fileName: string, code: string): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = [];

  if (!isArtifactFile(fileName)) {
    errors.push({
      code: 'bad-extension',
      message: '仅支持 .tsx 文件',
    });
  }

  const id = fileNameToId(fileName);
  if (!id) {
    errors.push({
      code: 'empty-id',
      message: '文件名归一化后 id 为空，请使用有意义的文件名',
    });
  }

  if (errors.length === 0) {
    const ts = await import('typescript');

    const result = ts.transpileModule(code, {
      reportDiagnostics: true,
      compilerOptions: {
        jsx: ts.JsxEmit.Preserve,
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
      },
      fileName,
    });

    const syntaxDiagnostics = (result.diagnostics ?? []).filter(
      (d) => d.category === ts.DiagnosticCategory.Error
    );

    if (syntaxDiagnostics.length > 0) {
      const message = ts.flattenDiagnosticMessageText(
        syntaxDiagnostics[0].messageText,
        '\n'
      );
      const pos =
        syntaxDiagnostics[0].file &&
        typeof syntaxDiagnostics[0].start === 'number'
          ? syntaxDiagnostics[0].file.getLineAndCharacterOfPosition(
              syntaxDiagnostics[0].start
            )
          : null;
      errors.push({
        code: 'syntax-error',
        message: pos
          ? `语法错误（${pos.line + 1}:${pos.character + 1}）：${message}`
          : `语法错误：${message}`,
      });
    } else if (!hasDefaultExport(ts, code, fileName)) {
      errors.push({
        code: 'missing-default-export',
        message: '缺少 default 导出（需要 export default 组件）',
      });
    }
  }

  return { ok: errors.length === 0, id, errors };
}

/**
 * Walk the source AST looking for any form of default export:
 *   export default function X() {}
 *   export default X
 *   export { X as default }
 */
function hasDefaultExport(
  ts: typeof import('typescript'),
  code: string,
  fileName: string
): boolean {
  const source = ts.createSourceFile(
    fileName,
    code,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TSX
  );

  let found = false;

  const visit = (node: import('typescript').Node): void => {
    if (found) return;

    const nodeWithModifiers = node as import('typescript').Node & {
      modifiers?: Array<{ kind: number }>;
    };
    const modifiers = nodeWithModifiers.modifiers ?? [];
    const hasExport = modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const hasDefault = modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (hasExport && hasDefault) {
      found = true;
      return;
    }

    if (
      ts.isExportAssignment(node) &&
      !node.isExportEquals
    ) {
      found = true;
      return;
    }

    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      const hasDefaultSpecifier = node.exportClause.elements.some(
        (spec) => spec.name.text === 'default'
      );
      if (hasDefaultSpecifier) {
        found = true;
        return;
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  return found;
}
