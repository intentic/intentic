import { shallowRef } from "vue";

// The drawn shape of an attached sound: bar heights and a length, decoded once per path from bytes already in this
// window. `barsFrom` is the whole reduction and takes no browser API, so the shape is unit-tested without an
// AudioContext; the decode around it is the only part that needs one.

// How many bars a waveform is drawn with. Fixed rather than measured from the chip's width: the bars flex to fill,
// and a count that changed with the panel would re-decode every time the chat column was dragged. 48 is what leaves
// a bar wider than the 1px gap beside it at the chip's own width; past that the row reads as noise.
export const WAVE_BARS = 48;

export interface AudioWave {
    /** One height per bar, 0..1, scaled so the loudest bar is exactly 1. */
    readonly bars: readonly number[];
    /** Seconds, from the decoded samples rather than the container's header, which can lie or be absent. */
    readonly duration: number;
}

// The loudest sample in each window, not the average: speech averages to near-silence everywhere and draws as a flat
// line, while the peak makes syllables visible. Scaled to the loudest bar afterwards for the same reason — at true
// amplitude a quietly recorded voice note is a flat line too, and the SHAPE is what tells one clip from another.
export const barsFrom = (samples: Float32Array, bars: number): number[] => {
    const heights: number[] = Array.from({ length: Math.max(0, bars) }, () => 0);
    if (heights.length === 0 || samples.length === 0) {
        return heights;
    }
    const per = samples.length / heights.length;
    let loudest = 0;
    for (let bar = 0; bar < heights.length; bar += 1) {
        // At least one sample per bar, so a clip shorter than `bars` samples still draws its own shape instead of
        // collapsing to zeros for every bar past the end.
        const from = Math.min(Math.floor(bar * per), samples.length - 1);
        const to = Math.min(Math.max(from + 1, Math.floor((bar + 1) * per)), samples.length);
        let peak = 0;
        for (let at = from; at < to; at += 1) {
            const level = Math.abs(samples[at] ?? 0);
            if (level > peak) {
                peak = level;
            }
        }
        heights[bar] = peak;
        loudest = Math.max(loudest, peak);
    }
    // Digital silence has no shape to scale; dividing by its zero would make every bar NaN and draw nothing at all.
    return loudest === 0 ? heights : heights.map((peak) => peak / loudest);
};

// OfflineAudioContext, not AudioContext: decoding must not open an output device, which Chrome keeps suspended until
// a user gesture and which flags the tab as playing. Its rate resamples the decode — 8kHz is far more than 56 bars
// need and keeps a long recording's decode cheap.
const DECODE_RATE = 8_000;

const decode = async (url: string): Promise<AudioWave> => {
    // The URL is this window's own object URL, so this "fetch" is a copy out of memory, not a request.
    const bytes = await (await fetch(url)).arrayBuffer();
    const buffer = await new OfflineAudioContext(1, 1, DECODE_RATE).decodeAudioData(bytes);
    return { bars: barsFrom(buffer.getChannelData(0), WAVE_BARS), duration: buffer.duration };
};

// shallowRef: waves are replaced wholesale, and deep reactivity over 56 numbers per attachment buys nothing.
const waves = shallowRef<Record<string, AudioWave>>({});
// Every path a decode was started for, whatever came of it. A path is one uuid-scoped file forever, so a finished
// attempt is never worth repeating — including a failed one, whose container will not become decodable.
const tried = new Set<string>();

// The waveform for an attachment, starting the decode on first ask. Undefined while it runs and forever for a
// container this browser cannot decode; the chip draws its flat resting shape until (or unless) one lands.
export const audioWave = (path: string, url: string): AudioWave | undefined => {
    const held = waves.value[path];
    if (held !== undefined || tried.has(path)) {
        return held;
    }
    tried.add(path);
    void decode(url).then(
        (wave) => {
            waves.value = { ...waves.value, [path]: wave };
        },
        // Nothing to report here: the <audio> element fails on the same bytes and says so in the chip.
        () => undefined,
    );
    return undefined;
};
