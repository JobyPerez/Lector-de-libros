import type { BookGalleryPage, BookOutlineEntry } from "../../app/api";

export type GalleryOutlinePageGroup = { id: string; pageIds: string[]; sharedHeadings: BookOutlineEntry[] };
export type GalleryOutlineNode = {
  id: string;
  heading: BookOutlineEntry | null;
  headings: BookOutlineEntry[];
  children: GalleryOutlineNode[];
  groups: GalleryOutlinePageGroup[];
  sharedPageIds: string[];
};

export function groupPagesByOutline(pages: Pick<BookGalleryPage, "pageId" | "pageNumber">[], outline: BookOutlineEntry[]): GalleryOutlineNode[] {
  const roots: GalleryOutlineNode[] = [];
  const headingsByPage = new Map<number, BookOutlineEntry[]>();
  for (const heading of [...outline].sort((a, b) => a.pageNumber - b.pageNumber || a.paragraphNumber - b.paragraphNumber)) {
    const entries = headingsByPage.get(heading.pageNumber) ?? [];
    entries.push(heading);
    headingsByPage.set(heading.pageNumber, entries);
  }
  const preamble: GalleryOutlineNode = { id: "preamble", heading: null, headings: [], children: [], groups: [], sharedPageIds: [] };
  let active: GalleryOutlineNode[] = [];
  for (const page of [...pages].sort((a, b) => a.pageNumber - b.pageNumber)) {
    const starts = headingsByPage.get(page.pageNumber) ?? [];
    // Continuation comes from actual content order, not from an OCR paragraph number.
    const memberships = new Set<GalleryOutlineNode>(starts.length && starts[0]!.beginsPageContent !== false ? [] : active);
    for (const heading of starts) {
      active = active.filter((parent) => parent.heading!.level < heading.level);
      const node: GalleryOutlineNode = {
        id: heading.chapterId ?? `heading-${heading.pageNumber}-${heading.paragraphNumber}`,
        heading, headings: [heading], children: [], groups: [], sharedPageIds: []
      };
      (active.at(-1)?.children ?? roots).push(node);
      active.push(node);
      for (const entry of active) memberships.add(entry);
    }
    const owner = active.at(-1) ?? preamble;
    if (owner === preamble && !roots.includes(preamble)) roots.push(preamble);
    const otherBranches = [...memberships].filter((node) => !active.includes(node));
    // Store one card in the newest section. Earlier branches retain only shared-page membership.
    for (const node of otherBranches) node.sharedPageIds.push(page.pageId);
    const sharedHeadings = otherBranches.length ? [...otherBranches.map((node) => node.heading!), owner.heading!] : [];
    const last = owner.groups.at(-1);
    const signature = sharedHeadings.map((heading) => heading.chapterId ?? `${heading.pageNumber}:${heading.paragraphNumber}`).join("|");
    if (last && last.sharedHeadings.map((heading) => heading.chapterId ?? `${heading.pageNumber}:${heading.paragraphNumber}`).join("|") === signature) last.pageIds.push(page.pageId);
    else owner.groups.push({ id: page.pageId, pageIds: [page.pageId], sharedHeadings });
  }
  const footprint = (node: GalleryOutlineNode): Set<string> => new Set([
    ...node.groups.flatMap((group) => group.pageIds),
    ...node.sharedPageIds,
    ...node.children.flatMap((child) => [...footprint(child)])
  ]);
  const sameFootprint = (left: GalleryOutlineNode, right: GalleryOutlineNode): boolean => {
    const a = footprint(left);
    const b = footprint(right);
    return a.size > 0 && a.size === b.size && [...a].every((id) => b.has(id));
  };
  const merge = (target: GalleryOutlineNode, source: GalleryOutlineNode): void => {
    target.headings.push(...source.headings);
    target.heading = target.headings[0] ?? null;
    target.children.push(...source.children);
    target.sharedPageIds = [...new Set([...target.sharedPageIds, ...source.sharedPageIds])];
    const seen = new Set<string>();
    target.groups = [...target.groups, ...source.groups].flatMap((group) => {
      const pageIds = group.pageIds.filter((id) => {
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      return pageIds.length ? [{ ...group, pageIds }] : [];
    });
  };
  const compact = (nodes: GalleryOutlineNode[]): GalleryOutlineNode[] => {
    const result: GalleryOutlineNode[] = [];
    for (const node of nodes) {
      node.children = compact(node.children);
      const previous = result.at(-1);
      if (previous && sameFootprint(previous, node)) {
        merge(previous, node);
        previous.children = compact(previous.children);
      } else result.push(node);
    }
    // Siblings must merge first: flattening can otherwise hide a shared scope.
    for (const node of result) {
      while (!node.groups.length && node.children.length === 1 && sameFootprint(node, node.children[0]!)) {
        const child = node.children[0]!;
        node.children = [];
        merge(node, child);
      }
    }
    return result;
  };
  const compacted = compact(roots);
  const covered = new Set<BookOutlineEntry>();
  const collectCoverage = (nodes: GalleryOutlineNode[]): void => {
    for (const node of nodes) {
      for (const group of node.groups) for (const heading of group.sharedHeadings) covered.add(heading);
      collectCoverage(node.children);
    }
  };
  collectCoverage(compacted);
  const prune = (nodes: GalleryOutlineNode[]): GalleryOutlineNode[] => nodes.filter((node) => {
    node.children = prune(node.children);
    // An uncovered heading remains even without a card; membership is not a UI reference.
    return node.groups.length > 0 || node.children.length > 0 || node.headings.some((heading) => !covered.has(heading));
  });
  return prune(compacted);
}
