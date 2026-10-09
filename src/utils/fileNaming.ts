/**
 * Generates clean, readable filenames based on the starting words of a script.
 * e.g., "Allow your body to settle comfortably into stillness" -> "allow-your-body-to-settle"
 */
export function getScriptSlug(text: string, maxWords: number = 5): string {
  if (!text || !text.trim()) return 'untitled-speech';

  // Extract first non-empty words
  const words = text
    .trim()
    .replace(/[<|>|#|*|_|[\]()]/g, '') // remove markdown / tags
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, maxWords);

  if (words.length === 0) return 'speech';

  const rawSlug = words
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-');

  return rawSlug || 'speech';
}
