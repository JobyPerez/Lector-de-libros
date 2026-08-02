export type ParagraphReadingMetrics = {
  characterCount: number;
  wordCount: number;
};

export function normalizeTextForDeepgram(text: string): string {
  return text.trim();
}

export function calculateParagraphReadingMetrics(text: string): ParagraphReadingMetrics {
  const normalizedText = normalizeTextForDeepgram(text);

  return {
    characterCount: normalizedText.length,
    wordCount: normalizedText ? normalizedText.split(/\s+/u).filter(Boolean).length : 0
  };
}
