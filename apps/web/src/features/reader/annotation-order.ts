// Unknown/deleted entries are ignored; new entries retain their natural order
// after the user's saved entries. Never mutate the shared navigation list.
export function applyAnnotationOrder<T extends { key: string }>(items: T[], keys: string[]): T[] {
  const positions = new Map(keys.map((key, index) => [key, index]));
  return [...items].sort((a, b) => (positions.get(a.key) ?? keys.length) - (positions.get(b.key) ?? keys.length));
}

export function moveAnnotation<T extends { key: string }>(items: T[], sourceKey: string, targetKey: string): T[] {
  const from = items.findIndex((item) => item.key === sourceKey);
  const to = items.findIndex((item) => item.key === targetKey);
  if (from < 0 || to < 0 || from === to) return items;
  const result = [...items];
  const [moved] = result.splice(from, 1);
  result.splice(to, 0, moved!);
  return result;
}
