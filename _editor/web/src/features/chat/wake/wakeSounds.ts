// The wake listener's few sounds, made rather than shipped: a person calling the agent across the room is not looking at
// the screen, so hearing it heard is the only way they know. Tones, never words, so the microphone cannot take one for a
// person calling it; the listener rests for as long as one plays all the same (wakeSoundMs).
// - `heard`: the name, with nothing asked yet: two notes up, "go on".
// - `sent`: the words went (or answered a card): one soft note.
// - `dropped`: what was heard went nowhere (cancelled, timed out, another device took it): two notes down.

export type WakeSound = `heard` | `sent` | `dropped`;

const NOTES = {
    heard: [660, 880],
    sent: [740],
    dropped: [660, 494],
} as const satisfies Record<WakeSound, readonly number[]>;

const NOTE_MS = 110;

/** How long a sound lasts, for the listener to rest through it. */
export const wakeSoundMs = (sound: WakeSound): number => NOTES[sound].length * NOTE_MS + 60;

// One context for every sound, made at the first: a page may hold only a few.
// allow(module-state): the page's one context for these sounds
let context: AudioContext | undefined;

export const playWakeSound = (sound: WakeSound): void => {
    // Only where the listener runs, which already has a running context of its own: a page with none hears nothing.
    if (!(`AudioContext` in globalThis)) {
        return;
    }
    context ??= new AudioContext();
    const audio = context;
    // allow(silent-catch): a context the browser will not start yet plays nothing, which is all a sound can lose.
    void audio.resume().catch(() => {});
    const start = audio.currentTime + 0.02;
    NOTES[sound].forEach((frequency, index) => {
        const at = start + (index * NOTE_MS) / 1000;
        const tone = audio.createOscillator();
        const gain = audio.createGain();
        tone.type = `sine`;
        tone.frequency.value = frequency;
        // A short swell and fade: a click-free note, quiet enough not to startle.
        gain.gain.setValueAtTime(0, at);
        gain.gain.linearRampToValueAtTime(0.12, at + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + NOTE_MS / 1000);
        tone.connect(gain).connect(audio.destination);
        tone.start(at);
        tone.stop(at + NOTE_MS / 1000 + 0.02);
    });
};
