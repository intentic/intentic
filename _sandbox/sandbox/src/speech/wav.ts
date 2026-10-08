// A WAV utterance to the 16 kHz mono float samples the speech models hear. Both callers send 16 kHz mono s16le (the
// composer's wavOf16k, Discord's downmix), so the common case is a straight read; any other PCM16 rate or channel count
// is downmixed and resampled rather than refused.

export const SPEECH_SAMPLE_RATE = 16_000;

export class WavFormatError extends Error {}

const chunkAt = (wav: Buffer, id: string): { readonly start: number; readonly size: number } | undefined => {
    let at = 12;
    while (at + 8 <= wav.length) {
        const size = wav.readUInt32LE(at + 4);
        if (wav.toString("ascii", at, at + 4) === id) {
            return { start: at + 8, size: Math.min(size, wav.length - at - 8) };
        }
        // Chunks are word-aligned: an odd size carries a pad byte.
        at += 8 + size + (size % 2);
    }
    return undefined;
};

export const wavSamples = (wav: Buffer): Float32Array => {
    if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
        throw new WavFormatError("not a WAV file");
    }
    const format = chunkAt(wav, "fmt ");
    const data = chunkAt(wav, "data");
    if (format === undefined || data === undefined || format.size < 16) {
        throw new WavFormatError("a WAV file without its format or data");
    }
    const encoding = wav.readUInt16LE(format.start);
    const channels = wav.readUInt16LE(format.start + 2);
    const rate = wav.readUInt32LE(format.start + 4);
    const bits = wav.readUInt16LE(format.start + 14);
    if (encoding !== 1 || bits !== 16 || channels < 1 || rate < 1) {
        throw new WavFormatError(`only 16-bit PCM is heard, not format ${encoding} at ${bits} bits`);
    }
    const frames = Math.floor(data.size / (2 * channels));
    const mono = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
        let sum = 0;
        for (let channel = 0; channel < channels; channel += 1) {
            sum += wav.readInt16LE(data.start + (frame * channels + channel) * 2);
        }
        mono[frame] = sum / channels / 32_768;
    }
    return resampleTo16k(mono, rate);
};

// Linear interpolation; speech survives it, and every caller already sends 16 kHz.
export const resampleTo16k = (samples: Float32Array, rate: number): Float32Array => {
    if (rate === SPEECH_SAMPLE_RATE) {
        return samples;
    }
    const ratio = rate / SPEECH_SAMPLE_RATE;
    const out = new Float32Array(Math.floor(samples.length / ratio));
    for (let index = 0; index < out.length; index += 1) {
        const at = index * ratio;
        const below = Math.floor(at);
        const above = Math.min(below + 1, samples.length - 1);
        const between = at - below;
        out[index] = (samples[below] ?? 0) * (1 - between) + (samples[above] ?? 0) * between;
    }
    return out;
};

// s16le PCM as the stream route receives it, to float samples.
export const pcm16Samples = (pcm: Uint8Array): Float32Array => {
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const out = new Float32Array(Math.floor(pcm.byteLength / 2));
    for (let index = 0; index < out.length; index += 1) {
        out[index] = view.getInt16(index * 2, true) / 32_768;
    }
    return out;
};
