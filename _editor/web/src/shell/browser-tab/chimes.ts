// The two sounds the app makes, and only when the reader said it may (tabPreferences.ts). Synthesized rather than
// shipped as files: two short sine notes each, nothing to download, and nothing that can fail to load at the moment
// one is wanted.
// - `asks`: a doorbell's falling third. Somebody is at the door, the one sound that means "come here".
// - `finished`: a soft rising fourth, quieter. Something resolved; nothing is owed.

export type Chime = `asks` | `finished`;

interface Note {
    // Seconds after the chime starts.
    readonly at: number;
    readonly hz: number;
    readonly seconds: number;
    readonly gain: number;
}

export const CHIMES = {
    asks: [
        { at: 0, hz: 659.25, seconds: 0.5, gain: 0.2 },
        { at: 0.2, hz: 523.25, seconds: 0.75, gain: 0.2 },
    ],
    finished: [
        { at: 0, hz: 783.99, seconds: 0.35, gain: 0.11 },
        { at: 0.11, hz: 1046.5, seconds: 0.6, gain: 0.11 },
    ],
} as const satisfies Record<Chime, readonly Note[]>;

// One context for the window's life: a browser caps how many a page may open, and one allowed to play stays allowed.
let context: AudioContext | undefined;

const audio = (): AudioContext | undefined => {
    // Typed as always there; a browser without Web Audio (or a test page) has none.
    const Audio: typeof AudioContext | undefined = globalThis.AudioContext;
    if (context === undefined && Audio !== undefined) {
        try {
            context = new Audio();
        } catch {
            return undefined;
        }
    }
    return context;
};

// A bell rather than a beep: an instant rise, a long exponential fall, and a quiet octave above for the shimmer.
const ring = (audioContext: AudioContext, start: number, note: Note): void => {
    for (const [hz, gain] of [
        [note.hz, note.gain],
        [note.hz * 2, note.gain * 0.18],
    ] as const) {
        const oscillator = audioContext.createOscillator();
        oscillator.type = `sine`;
        oscillator.frequency.value = hz;
        const envelope = audioContext.createGain();
        const at = start + note.at;
        envelope.gain.setValueAtTime(0.0001, at);
        envelope.gain.exponentialRampToValueAtTime(gain, at + 0.012);
        envelope.gain.exponentialRampToValueAtTime(0.0001, at + note.seconds);
        oscillator.connect(envelope).connect(audioContext.destination);
        oscillator.start(at);
        oscillator.stop(at + note.seconds + 0.05);
    }
};

/**
 * Plays a chime in this window now. Silent, never throwing, where the browser refuses: a page nobody has clicked since
 * it loaded may not start sound, and a switch pressed in settings is exactly the click that lets it.
 */
export const playChime = async (chime: Chime): Promise<void> => {
    const audioContext = audio();
    if (audioContext === undefined) {
        return;
    }
    if (audioContext.state === `suspended`) {
        await audioContext.resume().catch(() => undefined);
    }
    if (audioContext.state !== `running`) {
        return;
    }
    const start = audioContext.currentTime + 0.02;
    for (const note of CHIMES[chime]) {
        ring(audioContext, start, note);
    }
};

// Several tabs of the app see the same roster and would all ring at once. The first to claim a chime rings it; the
// rest stay quiet until this much time has passed, which also keeps a burst of news to one sound.
export const CHIME_GAP_MS = 4_000;
const CLAIM_KEY = `intentic.chime-at`;

/** Whether this window may ring now, given when any window last rang; takes the turn if so. */
export const claimChime = (storage: Pick<Storage, `getItem` | `setItem`>, now: number): boolean => {
    const last = Number(storage.getItem(CLAIM_KEY) ?? 0);
    if (Number.isFinite(last) && now - last < CHIME_GAP_MS && now >= last) {
        return false;
    }
    storage.setItem(CLAIM_KEY, String(now));
    return true;
};

const claim = (): boolean => {
    try {
        return claimChime(localStorage, Date.now());
    } catch {
        // No storage: this window cannot coordinate, so it rings for itself.
        return true;
    }
};

/** Rings a chime in exactly one window of the app, the claim taken under a lock so two tabs cannot both win it. */
export const ringOnce = async (chime: Chime): Promise<void> => {
    // Typed as always there; a browser older than the Web Locks API has none.
    const locks: LockManager | undefined = navigator.locks;
    const won = locks === undefined ? claim() : await locks.request(`intentic.chime`, claim).catch(() => false);
    if (won) {
        await playChime(chime);
    }
};
