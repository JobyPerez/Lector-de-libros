export type CompletionSound = "error" | "success";

type AudioContextWindow = Window & typeof globalThis & {
  webkitAudioContext?: typeof AudioContext;
};

let audioContext: AudioContext | null = null;

function getAudioContext() {
  if (typeof window === "undefined") {
    return null;
  }

  const AudioContextConstructor = window.AudioContext
    ?? (window as AudioContextWindow).webkitAudioContext;
  if (!AudioContextConstructor) {
    return null;
  }

  audioContext ??= new AudioContextConstructor();
  return audioContext;
}

export function prepareCompletionSound() {
  const context = getAudioContext();
  if (context?.state === "suspended") {
    void context.resume().catch(() => {});
  }
}

export function playCompletionSound(sound: CompletionSound) {
  const context = getAudioContext();
  if (!context) {
    return;
  }

  const play = () => {
    const startAt = context.currentTime + 0.02;
    const frequencies = sound === "success" ? [523.25, 659.25] : [311.13, 196];

    frequencies.forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const noteStart = startAt + index * 0.13;
      const noteEnd = noteStart + (sound === "success" ? 0.18 : 0.24);

      oscillator.frequency.setValueAtTime(frequency, noteStart);
      oscillator.type = sound === "success" ? "sine" : "triangle";
      gain.gain.setValueAtTime(0.0001, noteStart);
      gain.gain.exponentialRampToValueAtTime(sound === "success" ? 0.16 : 0.2, noteStart + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, noteEnd);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(noteStart);
      oscillator.stop(noteEnd);
    });
  };

  if (context.state === "suspended") {
    void context.resume().then(play).catch(() => {});
    return;
  }

  play();
}
