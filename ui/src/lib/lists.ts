/**
 * Pairs each item with its position, for React keys on lists that are never
 * reordered or edited (stack frames, breadcrumbs, source lines), where the
 * position is the only stable identity an item has.
 */
export function numbered<T>(items: T[]): [position: number, item: T][] {
  return [...items.entries()];
}
