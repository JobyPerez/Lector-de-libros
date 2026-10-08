export function movePages(order: string[], selected: ReadonlySet<string>, target: string, position: "before" | "after") {
  if (selected.has(target) || !order.includes(target)) return order;
  const moving = order.filter((id) => selected.has(id));
  if (!moving.length) return order;
  const remaining = order.filter((id) => !selected.has(id));
  const index = remaining.indexOf(target) + (position === "after" ? 1 : 0);
  return [...remaining.slice(0, index), ...moving, ...remaining.slice(index)];
}

export function selectPageRange(order: string[], selected: ReadonlySet<string>, anchor: string | null, target: string) {
  const start = anchor ? order.indexOf(anchor) : -1;
  const end = order.indexOf(target);
  if (start < 0 || end < 0) return new Set([...selected, target]);
  return new Set([...selected, ...order.slice(Math.min(start, end), Math.max(start, end) + 1)]);
}
