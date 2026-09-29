// The one voice both chimes are played on: a sketch of the roneat thung, the low Khmer bamboo xylophone. Rendered
// sample by sample from what the instrument is (a bamboo bar over a trough, struck with a padded mallet) rather than
// from bare oscillators, which is what keeps it sounding like an object and not like a 1980s console. Pitches sit on
// the seven-equal division of the octave that pinpeat tuning is close to, so every step is a little wider than a whole
// tone; the fundamentals stay between 190 and 260 Hz and the mix is low-passed, so nothing is shrill.

export type Phrase = `asks` | `finished`;

export interface Note {
    /** Seconds after the phrase starts. */
    readonly at: number;
    readonly hz: number;
    /** Relative loudness inside the phrase; the whole phrase is scaled to its peak afterwards. */
    readonly gain: number;
}

const KHMER_BASE = 196; // G3
/** A step on the seven-equal octave above G3. */
const khmer = (step: number): number => KHMER_BASE * 2 ** (step / 7);

// Two bars, the last one rolled the way the roneat thung sustains a note: down for a call, up for done.
export const PHRASES: Record<Phrase, readonly Note[]> = {
    asks: [
        { at: 0, hz: khmer(2), gain: 1 },
        { at: 0.17, hz: khmer(0), gain: 0.95 },
        { at: 0.27, hz: khmer(0), gain: 0.55 },
        { at: 0.37, hz: khmer(0), gain: 0.35 },
    ],
    finished: [
        { at: 0, hz: khmer(0), gain: 0.9 },
        { at: 0.15, hz: khmer(3), gain: 1 },
        { at: 0.25, hz: khmer(3), gain: 0.5 },
        { at: 0.35, hz: khmer(3), gain: 0.3 },
    ],
};

/** How loud a phrase peaks: the finish is quieter, since nothing is owed. */
export const PEAK: Record<Phrase, number> = { asks: 0.3, finished: 0.2 };
/** How much room is around it, 0 dry to 1 a hall. */
export const SPACE = 0.24;
const LENGTH = 1.5;
const CUTOFF = 2600;

const TAU = Math.PI * 2;

// A strike's amplitude: a short curved rise (a felt mallet, not a click) and an exponential fall.
const strike = (t: number, attack: number, decay: number): number =>
    t < attack ? Math.sin((t / attack) * (Math.PI / 2)) ** 2 : Math.exp(-(t - attack) / decay);

// A round wooden fundamental that dies fast, one hollow overtone, and a faint third.
const PARTIALS = [
    { ratio: 1, gain: 1, decay: 0.32 },
    { ratio: 3.05, gain: 0.12, decay: 0.08 },
    { ratio: 5.6, gain: 0.03, decay: 0.03 },
] as const;
const ATTACK = 0.003;

const bar = (out: Float32Array, rate: number, note: Note, random: () => number): void => {
    const start = Math.round(note.at * rate);
    // The soft thump of the mallet meeting the bar, heard more than noticed.
    let low = 0;
    for (let index = start; index < Math.min(out.length, start + Math.round(0.03 * rate)); index++) {
        low += (random() * 2 - 1 - low) * 0.12;
        out[index] = (out[index] ?? 0) + low * note.gain * 0.18 * Math.exp(-(index - start) / rate / 0.006);
    }
    const end = Math.min(out.length, start + Math.round((ATTACK + PARTIALS[0].decay * 7) * rate));
    for (const partial of PARTIALS) {
        // A hair of detune per strike: no two real strikes are the same, and identical ones are what sound digital.
        const hz = note.hz * partial.ratio * (1 + (random() - 0.5) * 0.002);
        const phase = random() * TAU;
        for (let index = start; index < end; index++) {
            const t = (index - start) / rate;
            out[index] = (out[index] ?? 0) + Math.sin(TAU * hz * t + phase) * partial.gain * note.gain * strike(t, ATTACK, partial.decay);
        }
    }
};

// A small deterministic generator, so a phrase renders the same every time (and a test can hold it to that).
const seeded = (seed: number): (() => number) => {
    let state = seed >>> 0 || 1;
    return () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) / 4_294_967_296;
    };
};

// A two-pole low-pass run forwards once: the "felt over the speaker" that keeps it warm.
const lowPass = (samples: Float32Array, rate: number): void => {
    const smooth = 1 - Math.exp((-TAU * CUTOFF) / rate);
    let first = 0;
    let second = 0;
    for (let index = 0; index < samples.length; index++) {
        first += ((samples[index] ?? 0) - first) * smooth;
        second += (first - second) * smooth;
        samples[index] = second;
    }
};

/** One phrase as dry mono samples, peaking at PEAK[phrase]. */
export const renderPhrase = (phrase: Phrase, rate: number): Float32Array => {
    const samples = new Float32Array(Math.round(LENGTH * rate));
    const random = seeded(phrase === `asks` ? 7 : 13);
    for (const note of PHRASES[phrase]) {
        bar(samples, rate, note, random);
    }
    lowPass(samples, rate);
    let peak = 0;
    for (const sample of samples) {
        peak = Math.max(peak, Math.abs(sample));
    }
    const scale = peak === 0 ? 0 : PEAK[phrase] / peak;
    // A short fade at the very end, so a tail cut by the buffer's length never clicks.
    const fade = Math.round(0.05 * rate);
    for (let index = 0; index < samples.length; index++) {
        const left = samples.length - index;
        samples[index] = (samples[index] ?? 0) * scale * (left < fade ? left / fade : 1);
    }
    return samples;
};

/** A room to put it in: decaying stereo noise, darkened as it dies the way air and walls take the highs first. */
export const renderRoom = (rate: number, seconds = 1.6): readonly [Float32Array, Float32Array] => {
    const random = seeded(99);
    const channels = [new Float32Array(Math.round(seconds * rate)), new Float32Array(Math.round(seconds * rate))] as const;
    for (const channel of channels) {
        let low = 0;
        for (let index = 0; index < channel.length; index++) {
            const t = index / rate;
            const smooth = 0.5 * Math.exp(-t / 0.4) + 0.04;
            low += (random() * 2 - 1 - low) * smooth;
            channel[index] = low * Math.exp(-t / 0.35) * (t < 0.012 ? 0 : 1);
        }
    }
    return channels;
};
