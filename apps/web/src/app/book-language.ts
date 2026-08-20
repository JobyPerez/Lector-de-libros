export type BookLanguageCode = "es" | "it";

export const BOOK_LANGUAGE_OPTIONS: ReadonlyArray<{ label: string; value: BookLanguageCode }> = [
  { label: "Español", value: "es" },
  { label: "Italiano", value: "it" }
];

export const DEEPGRAM_TTS_VOICE_OPTIONS = {
  es: [
    { description: "Español peninsular natural", label: "Diana", value: "aura-2-diana-es" },
    { description: "Español peninsular natural", label: "Néstor", value: "aura-2-nestor-es" },
    { description: "Español peninsular natural", label: "Carina", value: "aura-2-carina-es" },
    { description: "Español peninsular natural", label: "Álvaro", value: "aura-2-alvaro-es" },
    { description: "Español peninsular natural", label: "Agustina", value: "aura-2-agustina-es" },
    { description: "Español peninsular natural", label: "Silvia", value: "aura-2-silvia-es" }
  ],
  it: [
    { description: "Italiano natural", label: "Livia", value: "aura-2-livia-it" },
    { description: "Italiano natural", label: "Demetra", value: "aura-2-demetra-it" },
    { description: "Italiano natural", label: "Cinzia", value: "aura-2-cinzia-it" },
    { description: "Italiano natural", label: "Elio", value: "aura-2-elio-it" },
    { description: "Italiano natural", label: "Cesare", value: "aura-2-cesare-it" }
  ]
} as const;

export const DEEPGRAM_TTS_MODELS = [
  ...DEEPGRAM_TTS_VOICE_OPTIONS.es.map((voice) => voice.value),
  ...DEEPGRAM_TTS_VOICE_OPTIONS.it.map((voice) => voice.value)
] as const;

export const DEFAULT_DEEPGRAM_VOICE_MODEL: Record<BookLanguageCode, string> = {
  es: "aura-2-diana-es",
  it: "aura-2-livia-it"
};

export const DEFAULT_DEVICE_VOICE_URI = "";

const voiceStorageKey = "lector.reader.voiceModel";
const deviceVoiceStorageKey = "lector.reader.deviceVoiceUri";

export function normalizeBookLanguageCode(value: string | null | undefined): BookLanguageCode {
  return value === "it" ? "it" : "es";
}

export function getBookLanguageLabel(languageCode: BookLanguageCode | null | undefined): string {
  return normalizeBookLanguageCode(languageCode) === "it" ? "Italiano" : "Español";
}

export function getBookLanguageName(languageCode: BookLanguageCode): string {
  return languageCode === "it" ? "italiano" : "español";
}

export function getSpeechLanguage(languageCode: BookLanguageCode): "es-ES" | "it-IT" {
  return languageCode === "it" ? "it-IT" : "es-ES";
}

export function getDeepgramVoiceOptions(languageCode: BookLanguageCode) {
  return DEEPGRAM_TTS_VOICE_OPTIONS[languageCode];
}

export function isDeepgramVoiceForLanguage(value: string, languageCode: BookLanguageCode): boolean {
  return DEEPGRAM_TTS_VOICE_OPTIONS[languageCode].some((voice) => voice.value === value);
}

export function readStoredVoiceModel(languageCode: BookLanguageCode, fallback?: string): string {
  const defaultModel = isDeepgramVoiceForLanguage(fallback ?? "", languageCode)
    ? fallback as string
    : DEFAULT_DEEPGRAM_VOICE_MODEL[languageCode];
  if (typeof window === "undefined") {
    return defaultModel;
  }

  const storedModel = window.localStorage.getItem(`${voiceStorageKey}.${languageCode}`)
    ?? (languageCode === "es" ? window.localStorage.getItem(voiceStorageKey) : null);
  return storedModel && isDeepgramVoiceForLanguage(storedModel, languageCode) ? storedModel : defaultModel;
}

export function writeStoredVoiceModel(languageCode: BookLanguageCode, voiceModel: string): void {
  if (typeof window !== "undefined" && isDeepgramVoiceForLanguage(voiceModel, languageCode)) {
    window.localStorage.setItem(`${voiceStorageKey}.${languageCode}`, voiceModel);
  }
}

export function readStoredDeviceVoiceUri(languageCode: BookLanguageCode): string {
  if (typeof window === "undefined") {
    return DEFAULT_DEVICE_VOICE_URI;
  }

  return window.localStorage.getItem(`${deviceVoiceStorageKey}.${languageCode}`)
    ?? (languageCode === "es" ? window.localStorage.getItem(deviceVoiceStorageKey) : null)
    ?? DEFAULT_DEVICE_VOICE_URI;
}

export function writeStoredDeviceVoiceUri(languageCode: BookLanguageCode, voiceUri: string): void {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(`${deviceVoiceStorageKey}.${languageCode}`, voiceUri);
  }
}

function isDeviceVoiceForLanguage(voice: SpeechSynthesisVoice, languageCode: BookLanguageCode): boolean {
  const normalizedLanguage = voice.lang.trim().toLowerCase();
  return normalizedLanguage === languageCode || normalizedLanguage.startsWith(`${languageCode}-`);
}

export type DeviceVoiceOption = {
  description: string;
  label: string;
  value: string;
};

export function buildDeviceVoiceOptions(voices: SpeechSynthesisVoice[], languageCode: BookLanguageCode): DeviceVoiceOption[] {
  const uniqueVoices = new Map<string, DeviceVoiceOption>();
  for (const voice of voices) {
    if (!voice.voiceURI || uniqueVoices.has(voice.voiceURI) || !isDeviceVoiceForLanguage(voice, languageCode)) {
      continue;
    }

    const descriptionParts = [voice.lang.trim() || "Sin idioma"];
    if (voice.default) descriptionParts.push("predeterminada");
    if (voice.localService) descriptionParts.push("local");
    uniqueVoices.set(voice.voiceURI, {
      description: descriptionParts.join(" · "),
      label: voice.name,
      value: voice.voiceURI
    });
  }

  return [
    { description: "Usa la voz predeterminada del dispositivo", label: "Predeterminada", value: DEFAULT_DEVICE_VOICE_URI },
    ...Array.from(uniqueVoices.values()).sort((left, right) => left.label.localeCompare(right.label, languageCode))
  ];
}

export function findDeviceVoice(voices: SpeechSynthesisVoice[], voiceUri: string, languageCode: BookLanguageCode) {
  if (!voiceUri) return null;
  return voices.find((voice) => voice.voiceURI === voiceUri && isDeviceVoiceForLanguage(voice, languageCode)) ?? null;
}

export function pickFallbackDeviceVoice(voices: SpeechSynthesisVoice[], languageCode: BookLanguageCode) {
  return voices.find((voice) => isDeviceVoiceForLanguage(voice, languageCode)) ?? null;
}
