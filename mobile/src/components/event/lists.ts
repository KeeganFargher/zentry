// Small list and wording helpers the event views share, copied from the web
// (ui/src/lib/lists.ts and ui/src/components/json-view.tsx).

/**
 * Pairs each item with its position, for React keys on lists that are never
 * reordered or edited (stack frames, breadcrumbs, source lines), where the
 * position is the only stable identity an item has.
 */
export function numbered<T>(items: T[]): [position: number, item: T][] {
  return [...items.entries()];
}

const ACRONYMS = new Set(["id", "ip", "url", "sdk", "os", "cpu", "gpu", "api"]);

function capitalised(word: string): string {
  return ACRONYMS.has(word.toLowerCase())
    ? word.toUpperCase()
    : `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`;
}

/** "raw_description" → "Raw Description", "cloud.region" → "Cloud Region". */
export function words(key: string): string {
  return key
    .split(/[_.\s]+/)
    .flatMap((word) => (word === "" ? [] : [capitalised(word)]))
    .join(" ");
}

/** "1 frame", "3 frames". */
export function plural(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}
