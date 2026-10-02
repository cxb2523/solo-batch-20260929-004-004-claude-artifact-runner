/**
 * Single source of truth for registry id / source-file-name key
 * normalization.
 *
 * Rules (in order):
 *   1. lower-case
 *   2. whitespace runs and underscores become a single hyphen
 *   3. collapse consecutive separators (existing hyphens included)
 *   4. trim leading / trailing separators
 *
 * Both registry ids and source file names are mapped through this
 * function, so a case-insensitive file system resolves them to the
 * same key in both directions.
 */
export function slugify(input: string): string {
  return String(input ?? '')
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Remove the `.tsx` extension (case-insensitive) from a file name. */
export function stripTsxExtension(fileName: string): string {
  return String(fileName ?? '').replace(/\.tsx$/i, '');
}
/**
 * Registry key derived from a source file name.
 * `My_Widget.tsx`, `my widget.tsx` and `MY-WIDGET.TSX` all map to
 * `my-widget`.
 */
export function keyFromFileName(fileName: string): string {
  return slugify(stripTsxExtension(fileName));
}

/** Case-insensitive, normalization-aware equality of two keys/ids. */
export function sameKey(a: string, b: string): boolean {
  return slugify(a) === slugify(b);
}
