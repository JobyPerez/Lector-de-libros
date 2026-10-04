import { z } from "zod";

// Reserve explicit identities before matching the remaining paragraphs heuristically.
export function matchParagraphsWithExplicitIds<E extends { paragraphId: string }, R extends { paragraphId: string }>(
  existing: E[],
  replacements: R[],
  paragraphIds: (string | null)[] | undefined,
  matchRemaining: (existing: E[], replacements: R[]) => Map<string, R>
): Map<string, R> {
  const matches = new Map<string, R>();
  const reserved = new Set<R>();
  if (paragraphIds !== undefined) {
    const existingIds = new Set(existing.map((paragraph) => paragraph.paragraphId));
    if (paragraphIds.length !== replacements.length) {
      throw Object.assign(new z.ZodError([{ code: "custom", path: ["paragraphIds"], message: "paragraphIds debe estar alineado con los parrafos resultantes." }]), { statusCode: 400 });
    }
    paragraphIds.forEach((id, index) => {
      if (id === null) return;
      if (!existingIds.has(id) || matches.has(id)) {
        throw Object.assign(new z.ZodError([{ code: "custom", path: ["paragraphIds", index], message: "El ID debe pertenecer a esta pagina y no estar duplicado." }]), { statusCode: 400 });
      }
      const replacement = replacements[index]!;
      matches.set(id, replacement);
      reserved.add(replacement);
    });
  }
  const inferred = matchRemaining(existing.filter((paragraph) => !matches.has(paragraph.paragraphId)), replacements.filter((paragraph) => !reserved.has(paragraph)));
  for (const [id, replacement] of inferred) matches.set(id, replacement);
  return matches;
}
