/**
 * Shared utility functions used across multiple pipeline modules.
 */

/**
 * Strip HTML/XML tags and markdown-style characters from a string,
 * then normalise whitespace.  Single canonical implementation used by
 * cluster, dedup, ingest, and search-provider modules.
 */
export function stripMarkup(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_~`#[\]()!]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
