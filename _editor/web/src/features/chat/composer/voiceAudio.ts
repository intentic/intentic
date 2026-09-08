// Pure audio half of composer voice input: resampling, WAV framing, and the silence segmenter that turns a mic
// stream into discrete utterances. No DOM, no refs; runs under the node test environment as plain functions. Wire
// format is 16kHz mono s16le throughout, normalized here at the earliest point.

export const TARGET_RATE = 16_000;

// Linear-interpolation resample to 16kHz; naive (no low-pass), fine for speech. Swap in a real resampler if
// quality demands it.
export const resampleTo16k = (samples: Float32Array, inputRate: number): Float32Array => {
    if (inputRate === TARGET_RATE) {
        return samples;
    }
    const ratio = inputRate / TARGET_RATE;
    const out = new Float32Array(Math.floor(samples.length / ratio));
    for (let i = 0; i < out.length; i += 1) {
        const at = i * ratio;
        const index = Math.floor(at);
        const next = Math.min(index + 1, samples.length - 1);
        const between = at - index;
        out[i] = (samples[index] ?? 0) * (1 - between) + (samples[next] ?? 0) * between;
    }
    return out;
};

// Minimal RIFF/WAVE framing of 16kHz mono samples as s16le, exactly what whisper-cli expects. Floats clamp to
// [-1, 1] first to avoid integer wraparound from a hot microphone.
export const wavOf16k = (samples: Float32Array): ArrayBuffer => {
    const bytes = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(bytes);
    const ascii = (offset: number, text: string): void => {
        for (let i = 0; i < text.length; i += 1) {
            view.setUint8(offset + i, text.charCodeAt(i));
        }
    };
    ascii(0, `RIFF`);
    view.setUint32(4, 36 + samples.length * 2, true);
    ascii(8, `WAVE`);
    ascii(12, `fmt `);
    view.setUint32(16, 16, true); // fmt chunk size
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, TARGET_RATE, true);
    view.setUint32(28, TARGET_RATE * 2, true); // byte rate
    view.setUint16(32, 2, true); // block align
    view.setUint16(34, 16, true); // bits per sample
    ascii(36, `data`);
    view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i += 1) {
        const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
        view.setInt16(44 + i * 2, Math.round(clamped * 32_767), true);
    }
    return bytes;
};

// The segmenter decides where one spoken message ends; hands-free sending hangs on this boundary.
// - Hysteresis: a higher bar opens a segment than closes it, so breathing doesn't start one and a quiet word doesn't
//   end one.
// - Pre-roll: a short ring buffered while idle keeps the first syllable from being cut off.
// - Minimum speech: sub-blip segments (a cough, a key click) are dropped rather than sent.
// - Trailing-silence trim: the pause that closed the segment is trimmed off before sending.
// - Hard cap: matches the daemon's MAX_UTTERANCE_WAV_BYTES; a monologue is cut and sent rather than grown unbounded.
export interface SegmenterTuning {
    readonly startThreshold: number;
    readonly sustainThreshold: number;
    readonly silenceMs: number;
    readonly minSpeechMs: number;
    readonly prerollMs: number;
    readonly maxUtteranceMs: number;
    readonly keptTailMs: number;
}

const SEGMENTER_DEFAULTS: SegmenterTuning = {
    startThreshold: 0.015,
    sustainThreshold: 0.008,
    silenceMs: 1500,
    minSpeechMs: 300,
    prerollMs: 300,
    maxUtteranceMs: 60_000,
    keptTailMs: 250,
};

export interface Segmenter {
    /** Feed one frame of 16kHz mono samples; returns the frame's RMS level (0..1) for the meter. */
    readonly push: (frame: Float32Array) => number;
    /** Drop whatever is in flight; an unfinished segment is not a message. */
    readonly discard: () => void;
}

const rmsOf = (frame: Float32Array): number => {
    let sum = 0;
    for (let i = 0; i < frame.length; i += 1) {
        const sample = frame[i] ?? 0;
        sum += sample * sample;
    }
    return frame.length === 0 ? 0 : Math.sqrt(sum / frame.length);
};

const concat = (frames: readonly Float32Array[]): Float32Array => {
    const out = new Float32Array(frames.reduce((total, frame) => total + frame.length, 0));
    let at = 0;
    for (const frame of frames) {
        out.set(frame, at);
        at += frame.length;
    }
    return out;
};

export const createSegmenter = (onUtterance: (samples: Float32Array) => void, tuning: Partial<SegmenterTuning> = {}): Segmenter => {
    const config = { ...SEGMENTER_DEFAULTS, ...tuning };
    const msOf = (samples: number): number => (samples / TARGET_RATE) * 1000;

    // Idle: a rolling pre-roll ring. Speaking: the segment so far, its trailing silence, and how much was voiced.
    let frames: Float32Array[] = [];
    let framesMs = 0;
    let speaking = false;
    let silenceTailMs = 0;
    let voicedMs = 0;

    const reset = (): void => {
        frames = [];
        framesMs = 0;
        speaking = false;
        silenceTailMs = 0;
        voicedMs = 0;
    };

    const close = (): void => {
        // The pause that closed the segment is not part of the message; trim it to a natural beat.
        const dropMs = Math.max(0, silenceTailMs - config.keptTailMs);
        const keep = Math.max(1, Math.round(((framesMs - dropMs) / 1000) * TARGET_RATE));
        const samples = concat(frames).slice(0, keep);
        const voiced = voicedMs;
        reset();
        if (voiced >= config.minSpeechMs) {
            onUtterance(samples);
        }
    };

    return {
        push: (frame) => {
            const level = rmsOf(frame);
            const frameMs = msOf(frame.length);
            if (!speaking) {
                // A loud frame opens the segment over the ring; a quiet one joins it, trimmed back to pre-roll.
                frames.push(frame);
                framesMs += frameMs;
                if (level >= config.startThreshold) {
                    speaking = true;
                    voicedMs = frameMs;
                } else {
                    while (frames.length > 1 && framesMs - msOf(frames[0]?.length ?? 0) >= config.prerollMs) {
                        framesMs -= msOf(frames.shift()?.length ?? 0);
                    }
                }
                return level;
            }
            frames.push(frame);
            framesMs += frameMs;
            if (level >= config.sustainThreshold) {
                silenceTailMs = 0;
                voicedMs += frameMs;
            } else {
                silenceTailMs += frameMs;
            }
            if (silenceTailMs >= config.silenceMs || framesMs >= config.maxUtteranceMs) {
                close();
            }
            return level;
        },
        discard: reset,
    };
};
