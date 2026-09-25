import { runWhisper, type WhisperExec } from "@intentic/base/whisper";
import { cleanTranscription } from "@intentic/sandbox-contract";

// PCM downsampling, WAV framing, whisper-cli transcription, and a serialized transcriber queue for the voice session;
// pure of Discord and the daemon, so it unit-tests in isolation.

// Dropped below this: sub-quarter-second blips feed only hallucinations (192,000 B/s at 48kHz stereo).
export const MIN_UTTERANCE_BYTES = 48_000;

// Shown when whisper isn't installed; routes the agent to the pending rebuild instead of a doomed retry loop.
export const WHISPER_MISSING =
    "whisper-cli isn't installed in this sandbox yet. It's part of the environment overlay that was composed when " +
    "Discord was connected: the sandbox needs a one-time rebuild. Ask the owner to run the rebuild command shown on " +
    "the Sandbox page's Environment card, and don't retry joining voice (or propose an overlay) until it has landed.";

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

// Minimal RIFF/WAVE header for 16kHz mono s16le, what whisper-cli expects.
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

// One whisper-cli run at a time: transcription is CPU-bound and the sandbox is small, so utterances queue. `onLine`
// runs inside that queue after each line; its failures land in `onError` too.
export const createTranscriber = (
    modelPath: string,
    language: string,
    startedAt: number,
    onLine: (sorted: { at: number; line: string }[], newLine: string) => Promise<void>,
    onError: (error: unknown) => void,
    exec?: WhisperExec,
): Transcriber => {
    const lines: { at: number; line: string }[] = [];
    let queue: Promise<void> = Promise.resolve();
    return {
        push: (speaker, atMs, pcm) => {
            queue = queue
                .then(async () => {
                    const text = cleanTranscription(await runWhisper(wavOf(to16kMonoPcm(pcm)), { model: modelPath, language, exec }));
                    if (text !== undefined) {
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
