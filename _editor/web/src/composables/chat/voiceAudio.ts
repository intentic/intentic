/* The pure audio half of composer voice input: resampling, WAV framing, and the silence segmenter that turns a
 * continuous microphone stream into discrete utterances. No DOM and no refs — useVoiceInput.ts is the browser
 * glue over this, and these run under the node test environment as plain functions.
 *
 * Everything downstream (the daemon's whisper-cli, see _sandbox/sandbox/src/speech/transcribe.ts) speaks
 * 16kHz mono s16le, so the capture rate is normalized here at the earliest moment and every buffer after the
 * resample is already in the wire format's sample rate. */

export const TARGET_RATE = 16_000;

// Linear-interpolation resample to 16kHz. Naive (no low-pass) — fine for speech, same trade the Discord voice
// path makes; swap in a real resampler if quality nags.
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

// Minimal RIFF/WAVE framing of 16kHz mono float samples as s16le — byte-for-byte what whisper-cli expects
// (the daemon never decodes audio; the page ships the exact wire format). Floats clamp to [-1, 1] first: a
// hot microphone overshoots, and integer wraparound turns clipping into crackle.
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

/* THE SEGMENTER — the state machine that decides where one spoken message ends. Hands-free sending hangs
 * entirely off this boundary: ~1.5s of quiet is the "I'm done" gesture, so the constants are UX, not tuning
 * trivia.
 *
 *  - Hysteresis (start above 0.015 RMS, sustain above 0.008): breathing and room tone must not open a
 *    segment, but a quiet word mid-sentence must not close one.
 *  - Pre-roll (300ms ring while idle): the first syllable is what TRIPS the threshold, so without it every
 *    utterance arrives beheaded.
 *  - Minimum speech (300ms): sub-blip segments (a cough, a key click) only feed whisper hallucinations —
 *    same rationale as Discord voice's MIN_UTTERANCE_BYTES.
 *  - Trailing-silence trim (250ms kept): the 1.5s pause that CLOSED the segment is not part of the message,
 *    and whisper time is paid per second of audio.
 *  - Hard cap (2 minutes): matches the daemon's MAX_UTTERANCE_WAV_BYTES; a monologue is cut and sent rather
 *    than grown until the route refuses it. */
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
    maxUtteranceMs: 120_000,
    keptTailMs: 250,
};

export interface Segmenter {
    /** Feed one frame of 16kHz mono samples; returns the frame's RMS level (0..1) for the meter. */
    readonly push: (frame: Float32Array) => number;
    /** Drop whatever is in flight — the mic was turned off, and a segment nobody finished is not a message. */
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

    // While idle: a rolling pre-roll ring. While speaking: the segment so far, plus how much of its tail is
    // uninterrupted silence and how much of the whole was actually voiced.
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
        // The pause that closed the segment is not part of the message — trim it down to a natural beat.
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
                // Idle: a loud frame opens the segment over the untrimmed ring (the full pre-roll plus itself);
                // a quiet one joins the ring, which is then trimmed back to the pre-roll window.
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
