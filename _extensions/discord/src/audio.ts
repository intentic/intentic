// PCM downsampling, WAV framing, and a serialized transcriber queue for the voice session; pure of Discord, and handed
// its transcription (the daemon's speech engine, through the gateway's daemon client) so it unit-tests in isolation.

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
    // Wait out the queue and return the transcript lines in speech order.
    readonly flush: () => Promise<{ at: number; line: string }[]>;
    readonly transcribed: () => number;
}

// One utterance's 16 kHz mono WAV to its words, empty when it held none.
export type Transcribe = (wav: Buffer, language: string | undefined) => Promise<string>;

// One utterance at a time, in the order they ended: the transcript is rewritten after each, so a later one must not
// overtake an earlier. `onLine` runs inside that queue after each line; its failures land in `onError` too.
export const createTranscriber = (
    transcribe: Transcribe,
    language: string | undefined,
    startedAt: number,
    onLine: (sorted: { at: number; line: string }[], newLine: string) => Promise<void>,
    onError: (error: unknown) => void,
): Transcriber => {
    const lines: { at: number; line: string }[] = [];
    let queue: Promise<void> = Promise.resolve();
    return {
        push: (speaker, atMs, pcm) => {
            queue = queue
                .then(async () => {
                    const text = (await transcribe(wavOf(to16kMonoPcm(pcm)), language)).trim();
                    if (text !== "") {
                        const line = `[${elapsedLabel(atMs - startedAt)}] ${speaker}: ${text}`;
                        lines.push({ at: atMs, line });
                        await onLine(
                            lines.toSorted((a, b) => a.at - b.at),
                            line,
                        );
                    }
                })
                .catch(onError);
        },
        flush: async () => {
            await queue;
            return lines.toSorted((a, b) => a.at - b.at);
        },
        transcribed: () => lines.length,
    };
};
