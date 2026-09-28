/**
 * Lightweight Beta-quality sound feedback for the Session UI (P2 spec,
 * "Sound"). Synthesized with the Web Audio API -- no audio files, no third-
 * party dependency, matching the spec's explicit preference. Every export
 * is a fire-and-forget function that is always safe to call:
 *
 *  - No-ops (never throws) when `window`/AudioContext is unavailable --
 *    server-side rendering, an unsupported browser, or a locked-down test
 *    environment.
 *  - Never throws from Web Audio itself; a failure is swallowed, since
 *    sound is presentation polish and must never block the answer loop
 *    (MVP_UI_SPEC.md 2.3).
 *  - Lazily creates a single shared AudioContext on first call, honoring
 *    autoplay restrictions: this module never creates or resumes the
 *    context on its own, only in response to a caller invoking one of
 *    these functions, which the Session screen only ever does from inside
 *    a real user interaction handler (Reveal tap, grade tap).
 */

interface WebkitWindow extends Window {
  webkitAudioContext?: typeof AudioContext;
}

let sharedContext: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (typeof window === "undefined") return null;

  const Ctor = window.AudioContext ?? (window as WebkitWindow).webkitAudioContext;
  if (!Ctor) return null;

  try {
    if (!sharedContext) {
      sharedContext = new Ctor();
    }
    if (sharedContext.state === "suspended") {
      void sharedContext.resume();
    }
    return sharedContext;
  } catch {
    return null;
  }
}

interface ToneSpec {
  readonly freq: number;
  readonly duration: number;
  readonly type: OscillatorType;
  readonly gain: number;
  readonly delay?: number;
}

function playTone(context: AudioContext, { freq, duration, type, gain, delay = 0 }: ToneSpec): void {
  const startAt = context.currentTime + delay;
  const osc = context.createOscillator();
  const gainNode = context.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(freq, startAt);

  gainNode.gain.setValueAtTime(0, startAt);
  gainNode.gain.linearRampToValueAtTime(gain, startAt + 0.01);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);

  osc.connect(gainNode);
  gainNode.connect(context.destination);

  osc.start(startAt);
  osc.stop(startAt + duration + 0.02);
}

function safePlay(build: (context: AudioContext) => void): void {
  try {
    const context = getContext();
    if (!context) return;
    build(context);
  } catch {
    // Best-effort UX polish only -- never let a Web Audio failure surface.
  }
}

/** Subtle flip/whoosh at the moment Reveal is triggered. */
function playReveal(): void {
  safePlay((context) => playTone(context, { freq: 520, duration: 0.08, type: "sine", gain: 0.07 }));
}

/** Small positive hit sound for a normal Correct answer. */
function playCorrect(): void {
  safePlay((context) => playTone(context, { freq: 660, duration: 0.12, type: "triangle", gain: 0.14 }));
}

/** Stronger impact for a Critical hit -- noticeably bigger than a normal Correct. */
function playCritical(): void {
  safePlay((context) => {
    playTone(context, { freq: 440, duration: 0.16, type: "sawtooth", gain: 0.2 });
    playTone(context, { freq: 880, duration: 0.16, type: "sawtooth", gain: 0.14, delay: 0.05 });
  });
}

/** Short satisfying pop when an enemy is defeated. */
function playDefeat(): void {
  safePlay((context) => {
    playTone(context, { freq: 300, duration: 0.18, type: "square", gain: 0.13 });
    playTone(context, { freq: 520, duration: 0.16, type: "sine", gain: 0.11, delay: 0.09 });
  });
}

/** Soft, neutral sound for Wrong -- deliberately not a harsh buzzer/error tone. */
function playWrong(): void {
  safePlay((context) => playTone(context, { freq: 220, duration: 0.15, type: "sine", gain: 0.06 }));
}

export const sessionSounds = {
  reveal: playReveal,
  correct: playCorrect,
  critical: playCritical,
  defeat: playDefeat,
  wrong: playWrong,
};
