export function normalizedPdfWords(text: string): string[] {
  return text.replace(/!\[[\s\S]*?\]\([^)]*\)/gu, " ").replace(/lector-content-image:[\da-f-]+/giu, " ")
    .replace(/(\p{L})-\s+(\p{L})/gu, "$1$2").normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("es").match(/[\p{L}\p{N}]{3,}/gu) ?? [];
}
export function pdfTextSimilarity(target: string, source: string): number {
  const wanted = new Set(normalizedPdfWords(target));
  const available = new Set(normalizedPdfWords(source));
  return wanted.size ? [...wanted].filter((word) => available.has(word)).length / wanted.size : 0;
}
