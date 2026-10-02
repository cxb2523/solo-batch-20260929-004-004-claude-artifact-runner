import { keyFromFileName } from './slugify';

export interface ArtifactFile {
  name: string;
  content: string;
}

export type ArtifactErrorCode =
  | 'not-tsx'
  | 'empty-file'
  | 'empty-id'
  | 'syntax'
  | 'missing-default-export'
  | 'multiple-default-exports';

export interface ArtifactValidationError {
  code: ArtifactErrorCode;
  message: string;
  line?: number;
}

export type ValidationResult =
  | { ok: true; file: ArtifactFile }
  | { ok: false; file: ArtifactFile; error: ArtifactValidationError };

interface Frame {
  kind:
    | 'paren'
    | 'brace'
    | 'bracket'
    | 'template-text'
    | 'template-expr'
  | 'jsx-open'
  | 'jsx-children';
  tag?: string;
  /** Brace only: true when opened from JSX (child or attribute). */
  jsxExpr?: boolean;
}

type ScanState =
  | 'code'
  | 'line-comment'
  | 'block-comment'
  | 'single'
  | 'double'
  | 'regex'
  | 'regex-class';

const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete',
  'void', 'throw', 'else', 'do', 'case', 'yield', 'await',
]);

const REGEX_AFTER_CHARS = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', ';', '{', '+', '-',
  '*', '%', '~', '^', '\n',
]);

function lineAt(src: string, index: number): number {
  let line = 1;
  const end = Math.min(index, src.length - 1);
  for (let i = 0; i < end; i += 1) {
    if (src[i] === '\n') line += 1;
  }
  return line;
}

function isIdentStart(ch: string | undefined): boolean {
  return !!ch && /[A-Za-z_$]/.test(ch);
}

function readWord(src: string, start: number): string {
  let j = start + 1;
  while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j += 1;
  return src.slice(start, j);
}

function readTagName(src: string, start: number): string {
  let j = start;
  while (j < src.length && /[A-Za-z0-9._$-]/.test(src[j])) j += 1;
  return src.slice(start, j);
}

function skipCloseTag(src: string, start: number): number {
  let j = start;
  while (j < src.length && /\s/.test(src[j])) j += 1;
  while (j < src.length && /[A-Za-z0-9._$-]/.test(src[j])) j += 1;
  while (j < src.length && /\s/.test(src[j])) j += 1;
  return j;
}

function jsxAllowedHere(lastSignificant: string, lastWord: string): boolean {
  if (lastSignificant === '') return true;
  if (lastSignificant === 'w') {
    return REGEX_KEYWORDS.has(lastWord)
      || lastWord === 'const' || lastWord === 'let' || lastWord === 'var';
  }
  return lastSignificant === '=' || lastSignificant === '('
    || lastSignificant === ',' || lastSignificant === ':'
    || lastSignificant === '?' || lastSignificant === '{'
    || lastSignificant === '[' || lastSignificant === '\n'
    || lastSignificant === ';' || lastSignificant === '>';
}

/**
 * Structural syntax scan for TS/TSX artifacts.
 *
 * Tracks brackets, strings, template literals (including nested
 * `${ ... }`) and JSX element frames (open/self-closing/close tags
 * and `{expr}` child islands). Also distinguishes regex literals
 * from division for typical artifact code.
 */
export function findSyntaxError(src: string): { line: number } | null {
  const stack: Frame[] = [];
  let state: ScanState = 'code';
  let lastSignificant = '';
  let lastWord = '';

  const divisionPosition = (): boolean => {
    if (lastSignificant === '') return true;
    if (lastSignificant === 'w') return !REGEX_KEYWORDS.has(lastWord);
    if (lastSignificant === ')' || lastSignificant === ']'
      || lastSignificant === '}' || lastSignificant === "'"
      || lastSignificant === '"' || lastSignificant === '`'
      || lastSignificant === '.' || /[0-9]/.test(lastSignificant)) {
      return true;
    }
    return !REGEX_AFTER_CHARS.has(lastSignificant);
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (state === 'line-comment') {
      if (ch === '\n') { state = 'code'; lastSignificant = '\n'; }
      i += 1;
      continue;
    }
    if (state === 'block-comment') {
      if (ch === '*' && next === '/') { state = 'code'; i += 2; continue; }
      i += 1;
      continue;
    }
    if (state === 'single' || state === 'double') {
      const quote = state === 'single' ? "'" : '"';
      if (ch === '\\') { i += 2; continue; }
      if (ch === '\n') return { line: lineAt(src, i) };
      if (ch === quote) { state = 'code'; lastSignificant = quote; }
      i += 1;
      continue;
    }
    if (state === 'regex') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '\n') return { line: lineAt(src, i) };
      if (ch === '[') state = 'regex-class';
      else if (ch === '/') { state = 'code'; lastSignificant = '/'; }
      i += 1;
      continue;
    }
    if (state === 'regex-class') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '\n') return { line: lineAt(src, i) };
      if (ch === ']') state = 'regex';
      i += 1;
      continue;
    }

    const top = stack[stack.length - 1];

    if (ch === '/' && next === '/') { state = 'line-comment'; i += 2; continue; }
    if (ch === '/' && next === '*') { state = 'block-comment'; i += 2; continue; }

    // Inside a JSX open tag: quoted props, self-close, or finish.
    if (top?.kind === 'jsx-open') {
      if (ch === "'" || ch === '"') {
        state = ch === "'" ? 'single' : 'double';
        i += 1;
        continue;
      }
      if (ch === '{') {
        stack.push({ kind: 'brace', jsxExpr: true });
        lastSignificant = '{';
        i += 1;
        continue;
      }
      if (ch === '/' && next === '>') {
        stack.pop();
        lastSignificant = '>';
        i += 2;
        continue;
      }
      if (ch === '>') {
        top.kind = 'jsx-children';
        lastSignificant = '>';
        i += 1;
        continue;
      }
      if (ch === '<') return { line: lineAt(src, i) };
      i += 1;
      continue;
    }

    // JSX children: nested elements, closing tags, text, {expr}.
    if (top?.kind === 'jsx-children') {
      if (ch === '<' && next === '/') {
        const nameStart = skipCloseTag(src, i + 2);
        if (src[nameStart] !== '>') return { line: lineAt(src, i) };
        const closeName = src.slice(i + 2, nameStart).trim();
        if (closeName !== top.tag) return { line: lineAt(src, i + 2) };
        stack.pop();
        lastSignificant = '>';
        i = nameStart + 1;
        continue;
      }
      if (ch === '<' && isIdentStart(next)) {
        const tag = readTagName(src, i + 1);
        stack.push({ kind: 'jsx-open', tag });
        lastSignificant = '<';
        i += 1 + tag.length;
        continue;
      }
      if (ch === '{') {
        stack.push({ kind: 'brace', jsxExpr: true });
        lastSignificant = '{';
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }

    const inTemplateText = top?.kind === 'template-text';
    if (inTemplateText) {
      if (ch === '`') {
        stack.pop();
        lastSignificant = '`';
      } else if (ch === '\\') {
        i += 1;
      } else if (ch === '$' && next === '{') {
        top.kind = 'template-expr';
        lastSignificant = '{';
      }
      i += 1;
      continue;
    }

    if (ch === "'") { state = 'single'; i += 1; continue; }
    if (ch === '"') { state = 'double'; i += 1; continue; }
    if (ch === '`') {
      stack.push({ kind: 'template-text' });
      i += 1;
      continue;
    }
    if (ch === '/' && !divisionPosition()) {
      state = 'regex';
      i += 1;
      continue;
    }

    if (ch === '(' || ch === '{' || ch === '[') {
      stack.push({
        kind: ch === '(' ? 'paren' : ch === '{' ? 'brace' : 'bracket',
        // Nested braces inside a JSX expression stay in JSX scope.
        jsxExpr: ch === '{'
          ? stack[stack.length - 1]?.kind === 'brace'
            && stack[stack.length - 1]?.jsxExpr === true
          : undefined,
      });
      lastSignificant = ch;
      i += 1;
      continue;
    }
    if (ch === ')' || ch === '}' || ch === ']') {
      const wanted = ch === ')' ? 'paren' : ch === '}' ? 'brace' : 'bracket';
      if (ch === '}' && top?.kind === 'template-expr') {
        top.kind = 'template-text';
        lastSignificant = '}';
        i += 1;
        continue;
      }
      if (!top || top.kind !== wanted) return { line: lineAt(src, i) };
      stack.pop();
      if (ch === '}') {
        const parent = stack[stack.length - 1];
        // After a JSX expression we resume the tag/children scan;
        // avoid the `/` self-closing slash being read as a regex.
        if (parent?.kind === 'jsx-children' || parent?.kind === 'jsx-open') {
          lastSignificant = '}';
        }
        if (parent?.kind === 'template-expr') parent.kind = 'template-text';
      }
      lastSignificant = ch;
      i += 1;
      continue;
    }

    const parentFrame = stack[stack.length - 1];
    const jsxContext = parentFrame?.kind === 'brace' && parentFrame.jsxExpr === true;
    if (ch === '<'
      && isIdentStart(next)
      && (jsxContext || jsxAllowedHere(lastSignificant, lastWord))) {
      const tag = readTagName(src, i + 1);
      stack.push({ kind: 'jsx-open', tag });
      lastSignificant = '<';
      i += 1 + tag.length;
      continue;
    }

    if (isIdentStart(ch)) {
      lastWord = readWord(src, i);
      lastSignificant = 'w';
      i += lastWord.length;
      continue;
    }

    if (!/\s/.test(ch)) lastSignificant = ch;
    i += 1;
  }

  if (state === 'block-comment' || state === 'single' || state === 'double'
    || state === 'regex' || state === 'regex-class') {
    return { line: lineAt(src, src.length - 1) };
  }
  if (stack.length > 0) return { line: lineAt(src, src.length - 1) };
  return null;
}

/** Count runtime `export default ...` declarations (types ignored). */
export function countDefaultExports(src: string): number {
  let count = 0;
  const re = /\bexport\b/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(src)) !== null) {
    const windowText = src.slice(match.index, match.index + 200);
    if (/^export\s+type\b/.test(windowText)) continue;
    if (/^export\s+default\b/.test(windowText)) count += 1;
  }
  return count;
}

/**
 * Static gate every dropped `.tsx` must pass before touching the
 * registry or the persisted draft queue.
 */
export function validateArtifactFile(file: ArtifactFile): ValidationResult {
  if (!/\.tsx$/i.test(file.name)) {
    return {
      ok: false,
      file,
      error: { code: 'not-tsx', message: `仅支持 .tsx 文件：${file.name}` },
    };
  }
  if (!keyFromFileName(file.name)) {
    return {
      ok: false,
      file,
      error: {
        code: 'empty-id',
        message: '文件名归一化后 id 为空，无法登记（检查文件名是否只有符号）',
      },
    };
  }
  if (!file.content.trim()) {
    return {
      ok: false,
      file,
      error: { code: 'empty-file', message: '文件内容为空' },
    };
  }
  const syntaxError = findSyntaxError(file.content);
  if (syntaxError) {
    return {
      ok: false,
      file,
      error: {
        code: 'syntax',
        line: syntaxError.line,
        message: `语法错误：标签/括号/字符串未闭合（第 ${syntaxError.line} 行附近）`,
      },
    };
  }
  const defaultExports = countDefaultExports(file.content);
  if (defaultExports === 0) {
    return {
      ok: false,
      file,
      error: {
        code: 'missing-default-export',
        message: '缺少默认导出：需要 export default ...',
      },
    };
  }
  if (defaultExports > 1) {
    return {
      ok: false,
      file,
      error: {
        code: 'multiple-default-exports',
        message: `存在 ${defaultExports} 个默认导出，只能有一个`,
      },
    };
  }
  return { ok: true, file };
}

/**
 * Async entry point kept for callers that read files via Promise APIs.
 * The static check itself is synchronous and dependency-free.
 */
export async function validateArtifactFileAsync(
  file: ArtifactFile,
): Promise<ValidationResult> {
  return validateArtifactFile(file);
}
