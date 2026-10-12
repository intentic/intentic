import { errorMessage } from "@intentic/base/errors";

// PCM resampling both ways, WAV framing, and the two serialized queues of a voice session (what it hears, to be
// transcribed; what it says, to be spoken); pure of Discord, and handed its transcription and speech (the daemon's
// engines, through the gateway's daemon client) so it unit-tests in isolation.

// Dropped below this: sub-quarter-second blips feed only hallucinations (192,000 B/s at 48kHz stereo).
export const MIN_UTTERANCE_BYTES = 48_000;

// 48kHz stereo to 16kHz mono: averages each group of 6 samples into one. Naive decimation, no low-pass; fine for
// speech, swap in a real resampler if quality suffers.
export const to16kMonoPcm = (stereo48k: Buffer): Buffer => {
    const outFrames = Math.floor(stereo48k.length / 12);
    const out = Buffer.alloc(outFrames * 2);
    for (let i = 0; i < outFrames; i += 1) {
        let sum = 0;
        for (let sample = 0; sample < 6; sample += 1) {
            sum += stereo48k.readInt16LE(i * 12 + sample * 2);
        }
        out.writeInt16LE(Math.round(sum / 6), i * 2);
    }
    return out;
};

// Minimal RIFF/WAVE header for 16kHz mono s16le, what the daemon's /speech/transcribe reads.
export const wavOf = (pcm16kMono: Buffer): Buffer => {
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + pcm16kMono.length, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16); // fmt chunk size
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(16_000, 24); // sample rate
    header.writeUInt32LE(32_000, 28); // byte rate
    header.writeUInt16LE(2, 32); // block align
    header.writeUInt16LE(16, 34); // bits per sample
    header.write("data", 36);
    header.writeUInt32LE(pcm16kMono.length, 40);
    return Buffer.concat([header, pcm16kMono]);
};

const elapsedLabel = (ms: number): string => {
    const seconds = Math.max(0, Math.round(ms / 1000));
    return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};

export interface Transcriber {
    readonly push: (speaker: string, atMs: number, pcm48kStereo: Buffer) => void;
    // A line that needs no transcribing: what the bot itself said, written in its place so the transcript reads as the
    // conversation it was. `onLine` hears it as not heard, which is how it stays out of the voice_utterance events.
    readonly record: (speaker: string, atMs: number, text: string) => void;
    // Wait out the queue and return the transcript lines in speech order.
    readonly flush: () => Promise<{ at: number; line: string }[]>;
    // Lines heard from the people in the call, the bot's own left out.
    readonly transcribed: () => number;
}

// One utterance's 16 kHz mono WAV to its words, empty when it held none.
export type Transcribe = (wav: Buffer, language: string | undefined) => Promise<string>;

// One utterance at a time, in the order they ended: the transcript is rewritten after each, so a later one must not
// overtake an earlier. `onLine` runs inside that queue after each line, `heard` false for one the bot said; its failures
// land in `onError` too.
export const createTranscriber = (
    transcribe: Transcribe,
    language: string | undefined,
    startedAt: number,
    onLine: (sorted: { at: number; line: string }[], newLine: string, heard: boolean) => Promise<void>,
    onError: (error: Error) => void,
): Transcriber => {
    const lines: { at: number; line: string }[] = [];
    let heardLines = 0;
    let queue: Promise<void> = Promise.resolve();
    const append = async (speaker: string, atMs: number, text: string, heard: boolean): Promise<void> => {
        if (text === "") {
            return;
        }
        const line = `[${elapsedLabel(atMs - startedAt)}] ${speaker}: ${text}`;
        lines.push({ at: atMs, line });
        heardLines += heard ? 1 : 0;
        await onLine(
            lines.toSorted((a, b) => a.at - b.at),
            line,
            heard,
        );
    };
    return {
        push: (speaker, atMs, pcm) => {
            queue = queue.then(async () => append(speaker, atMs, (await transcribe(wavOf(to16kMonoPcm(pcm)), language)).trim(), true)).catch(onError);
        },
        record: (speaker, atMs, text) => {
            // One line per utterance, however the text was broken up.
            queue = queue.then(async () => append(speaker, atMs, text.replaceAll(/\s+/g, " ").trim(), false)).catch(onError);
        },
        flush: async () => {
            await queue;
            return lines.toSorted((a, b) => a.at - b.at);
        },
        transcribed: () => heardLines,
    };
};

// Discord's own audio: 48 kHz stereo s16le, sent as 20 ms Opus frames.
const DISCORD_RATE = 48_000;
export const DISCORD_FRAME_BYTES = (DISCORD_RATE / 50) * 2 * 2;

export interface Upsampler {
    // The next chunk of mono s16le, as many 48 kHz stereo frames as it completes; a chunk may end mid-sample.
    readonly push: (chunk: Uint8Array) => Buffer;
    // What the last sample still owes, held at its value (a byte left over is half a sample, and dropped).
    readonly end: () => Buffer;
}

// Each mono sample written to both channels.
const stereoOf = (samples: readonly number[]): Buffer => {
    const out = Buffer.alloc(samples.length * 4);
    samples.forEach((sample, i) => {
        out.writeInt16LE(sample, i * 4);
        out.writeInt16LE(sample, i * 4 + 2);
    });
    return out;
};

// Mono s16le at `rate` Hz to Discord's 48 kHz stereo, by linear interpolation, chunk by chunk as the daemon streams
// speech: the newest sample of one chunk is what the next interpolates from, and a byte that splits a sample waits for
// its other half. Output positions are counted in whole numbers, so a long utterance never drifts off the input's clock.
export const createUpsampler = (rate: number): Upsampler => {
    let odd: number | undefined;
    // Input samples taken so far, the newest of them, and the output sample due next.
    let seen = 0;
    let last = 0;
    let next = 0;
    return {
        push: (chunk) => {
            const bytes = odd === undefined ? Buffer.from(chunk) : Buffer.concat([Buffer.of(odd), chunk]);
            const count = Math.floor(bytes.length / 2);
            odd = bytes.length % 2 === 1 ? bytes.at(-1) : undefined;
            // Input sample `index` (counted from the utterance's start), which is `last` or one of this chunk's.
            const sampleAt = (index: number): number => (index < seen ? last : bytes.readInt16LE((index - seen) * 2));
            const total = seen + count;
            const out: number[] = [];
            // Output sample `next` sits at input position next·rate/48000: between samples i and i+1, so it waits until
            // i+1 has arrived.
            for (let i = Math.floor((next * rate) / DISCORD_RATE); i + 1 < total; i = Math.floor((next * rate) / DISCORD_RATE)) {
                const fraction = (next * rate - i * DISCORD_RATE) / DISCORD_RATE;
                const from = sampleAt(i);
                out.push(Math.round(from + (sampleAt(i + 1) - from) * fraction));
                next += 1;
            }
            last = count > 0 ? sampleAt(total - 1) : last;
            seen = total;
            return stereoOf(out);
        },
        end: () => {
            const out: number[] = [];
            for (; Math.floor((next * rate) / DISCORD_RATE) < seen; next += 1) {
                out.push(last);
            }
            return stereoOf(out);
        },
    };
};

// 48 kHz stereo PCM, from any rate the daemon speaks at, in whole 20 ms frames: the last padded out with silence, so the
// utterance ends on a frame like any other.
export async function* discordFramesOf(pcm: AsyncIterable<Uint8Array>, rate: number): AsyncGenerator<Buffer> {
    const upsampler = createUpsampler(rate);
    let pending: Buffer = Buffer.alloc(0);
    const framesOf = function* (more: Buffer): Generator<Buffer> {
        pending = pending.length === 0 ? more : Buffer.concat([pending, more]);
        let offset = 0;
        for (; pending.length - offset >= DISCORD_FRAME_BYTES; offset += DISCORD_FRAME_BYTES) {
            yield pending.subarray(offset, offset + DISCORD_FRAME_BYTES);
        }
        pending = pending.subarray(offset);
    };
    for await (const chunk of pcm) {
        yield* framesOf(upsampler.push(chunk));
    }
    yield* framesOf(upsampler.end());
    if (pending.length > 0) {
        const frame = Buffer.alloc(DISCORD_FRAME_BYTES);
        pending.copy(frame);
        yield frame;
    }
}

// How one queued utterance began: sounding, with nothing in it to say, cut before it began, or refused and why.
export type SayOutcome =
    | { readonly kind: "speaking" }
    | { readonly kind: "silent" }
    | { readonly kind: "stopped" }
    | { readonly kind: "failed"; readonly reason: string };

// Says one utterance into the call: calls `started` once it sounds, and settles when it has finished or `signal` cut it.
export type Speak = (text: string, signal: AbortSignal, started: () => void) => Promise<void>;

export interface SpeechQueue {
    // Queues an utterance behind the ones already waiting: `ahead` counts those in front of it, and `begun` settles when
    // it starts sounding, or with why it never will.
    readonly say: (text: string) => { readonly ahead: number; readonly begun: Promise<SayOutcome> };
    // Cuts the utterance being said and drops the ones waiting; how many that was.
    readonly stop: () => number;
    // Utterances being said or waiting.
    readonly size: () => number;
}

const STOPPED: SayOutcome = { kind: "stopped" };

// One utterance at a time, in the order they were asked: two answers spoken over each other are neither heard.
export const createSpeechQueue = (speak: Speak, onError: (error: Error) => void): SpeechQueue => {
    const waiting: { readonly text: string; readonly settle: (outcome: SayOutcome) => void }[] = [];
    let current: AbortController | undefined;
    const drain = (): void => {
        const item = current === undefined ? waiting.shift() : undefined;
        if (item === undefined) {
            return;
        }
        const controller = new AbortController();
        current = controller;
        // A promise settles once: `started` claims it first when the utterance sounds, so what follows only speaks for
        // one that never did.
        void speak(item.text, controller.signal, () => item.settle({ kind: "speaking" }))
            .then(() => item.settle(controller.signal.aborted ? STOPPED : { kind: "silent" }))
            .catch((error: Error) => {
                if (controller.signal.aborted) {
                    item.settle(STOPPED);
                    return;
                }
                onError(error);
                item.settle({ kind: "failed", reason: errorMessage(error) });
            })
            .finally(() => {
                current = undefined;
                drain();
            });
    };
    return {
        say: (text) => {
            const ahead = waiting.length + (current === undefined ? 0 : 1);
            const { promise, resolve } = Promise.withResolvers<SayOutcome>();
            waiting.push({ text, settle: resolve });
            drain();
            return { ahead, begun: promise };
        },
        stop: () => {
            const cut = waiting.length + (current === undefined ? 0 : 1);
            for (const item of waiting.splice(0)) {
                item.settle(STOPPED);
            }
            current?.abort();
            return cut;
        },
        size: () => waiting.length + (current === undefined ? 0 : 1),
    };
};
