// The two sounds the app makes, and only when the reader said it may (tabPreferences.ts). Synthesized rather than
// shipped as files: nothing to download, and nothing that can fail to load at the moment one is wanted. Both are
// played on a sketch of the roneat thung, the low Khmer bamboo xylophone (chimeSound.ts):
// - `asks`: a falling figure. Somebody is at the door, the one sound that means "come here".
// - `finished`: a rising one, quieter. Something resolved; nothing is owed.

import { renderPhrase, renderRoom, SPACE } from "./chimeSound";

export type Chime = `asks` | `finished`;

// One context for the window's life: a browser caps how many a page may open, and one allowed to play stays allowed.
let context: AudioContext | undefined;
let room: AudioBuffer | undefined;
// Rendered phrases, kept: a phrase is a few hundred milliseconds of arithmetic the first time and free after.
const rendered = new Map<Chime, AudioBuffer>();

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

const buffer = (audioContext: AudioContext, channels: readonly Float32Array[]): AudioBuffer => {
    const made = audioContext.createBuffer(channels.length, channels[0]?.length ?? 1, audioContext.sampleRate);
    channels.forEach((samples, index) => made.getChannelData(index).set(samples));
    return made;
};

const phrase = (audioContext: AudioContext, chime: Chime): AudioBuffer => {
    let made = rendered.get(chime);
    if (made === undefined) {
        made = buffer(audioContext, [renderPhrase(chime, audioContext.sampleRate)]);
        rendered.set(chime, made);
    }
    return made;
};

// The dry phrase, and the same phrase sent through a small room.
const sing = (audioContext: AudioContext, chime: Chime): void => {
    const source = audioContext.createBufferSource();
    source.buffer = phrase(audioContext, chime);
    room ??= buffer(audioContext, renderRoom(audioContext.sampleRate));
    const reverb = audioContext.createConvolver();
    reverb.buffer = room;
    const wet = audioContext.createGain();
    wet.gain.value = SPACE;
    source.connect(audioContext.destination);
    source.connect(reverb).connect(wet).connect(audioContext.destination);
    source.start(audioContext.currentTime + 0.02);
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
    sing(audioContext, chime);
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
