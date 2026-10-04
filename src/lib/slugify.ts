/**
 * Slug normalization — single source of truth.
 *
 * Rules (applied in order):
 *  1. lowercase
 *  2. whitespace and underscores become hyphens
 *  3. collapse runs of separators (hyphens) into one
 *  4. trim leading/trailing separators
 *
 * Every registry id is derived from the source file name through this
 * function, so case-insensitive file systems share the same key.
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Supported artifact source extension. */
export const ARTIFACT_EXT = '.tsx';

/** Strip the trailing artifact extension (case-insensitive). */
export function stripArtifactExt(fileName: string): string {
  return fileName.toLowerCase().endsWith(ARTIFACT_EXT)
    ? fileName.slice(0, -ARTIFACT_EXT.length)
    : fileName;
}

/**
 * Registry id for a source file name: base name (no directory), extension
 * stripped, then normalized through {@link slugify}.
 */
export function fileNameToId(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  return slugify(stripArtifactExt(base));
}

/**
 * Canonical on-disk source file name for a registry id.
 * Inverse of {@link fileNameToId} on the normalized id space.
 */
export function idToFileName(id: string): string {
  return `${slugify(id)}${ARTIFACT_EXT}`;
}

/** True when the file name carries the supported artifact extension. */
export function isArtifactFile(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(ARTIFACT_EXT);
}
