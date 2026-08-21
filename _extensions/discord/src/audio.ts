import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

// Audio + whisper primitives for the voice session: PCM downsampling, WAV framing, whisper-cli transcription,
// and a serialized transcriber queue. Pure of Discord and of the daemon, so they unit-test in isolation.

// Utterances shorter than this are dropped unheard, sub-quarter-second blips (key clicks, coughs) only feed
// whisper hallucinations. 48kHz stereo s16le = 192,000 bytes/s.
export const MIN_UTTERANCE_BYTES = 48_000;
const TRANSCRIBE_TIMEOUT_MS = 120_000;

export type ExecFn = (command: string, args: string[], options: { timeout: number }) => Promise<{ stdout: string }>;
const defaultExec: ExecFn = promisify(execFile);

// The message the model reads when whisper isn't provisioned, it routes the agent to the pending rebuild
// instead of a doomed retry loop (or a needless overlay proposal: the fragment is already composed).
export const WHISPER_MISSING =
    "whisper-cli isn't installed in this sandbox yet. It's part of the environment overlay that was composed when " +
    "Discord was connected: the sandbox needs a one-time rebuild. Ask the owner to run the rebuild command shown on " +
    "the Sandbox page's Environment card, and don't retry joining voice (or propose an overlay) until it has landed.";

// ENOENT on spawn ⇒ the binary isn't on PATH. Any other outcome (including a non-zero exit) means it exists.
export const whisperCliMissing = async (exec: ExecFn = defaultExec): Promise<boolean> => {
    try {
        await exec("whisper-cli", ["--help"], { timeout: 10_000 });
        return false;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
};

// 48kHz stereo s16le → 16kHz mono s16le: average each group of 3 stereo frames (6 samples) into one.
// ponytail: naive decimation without a low-pass, fine for speech; swap in a real resampler if quality nags.
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

// Whisper's stdout for one utterance → clean single-line text, or undefined for silence/noise-only output
// (whisper renders non-speech as bracketed annotations like [BLANK_AUDIO] or (wind blowing)).
export const cleanTranscription = (stdout: string): string | undefined => {
    const text = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "" && !/^[[(].*[\])]$/.test(line))
        .join(" ")
        .trim();
    return text === "" ? undefined : text;
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

// One whisper-cli run at a time, transcription is CPU-bound and the sandbox is small; utterances queue.
// `onLine` runs inside the queue after each transcribed line (live file write + utterance dispatch); its
// failures land in onError like a whisper failure would.
export const createTranscriber = (
    modelPath: string,
    language: string,
    startedAt: number,
    onLine: (sorted: { at: number; line: string }[], newLine: string) => Promise<void>,
    onError: (error: unknown) => void,
    exec: ExecFn = defaultExec,
): Transcriber => {
    const lines: { at: number; line: string }[] = [];
    let queue: Promise<void> = Promise.resolve();
    return {
        push: (speaker, atMs, pcm) => {
            queue = queue
                .then(async () => {
                    const wavPath = join(tmpdir(), `intentic-utterance-${randomUUID()}.wav`);
                    await writeFile(wavPath, wavOf(to16kMonoPcm(pcm)));
                    try {
                        // whisper-cli defaults to -l en, silently mangling other languages, always pass one.
                        const { stdout } = await exec(
                            "whisper-cli",
                            ["-m", modelPath, "-f", wavPath, "-l", language, "--no-timestamps", "--no-prints"],
                            { timeout: TRANSCRIBE_TIMEOUT_MS },
                        );
                        const text = cleanTranscription(stdout);
                        if (text !== undefined) {
                            const line = `[${elapsedLabel(atMs - startedAt)}] ${speaker}: ${text}`;
                            lines.push({ at: atMs, line });
                            await onLine(
                                lines.toSorted((a, b) => a.at - b.at),
                                line,
                            );
                        }
                    } finally {
                        await rm(wavPath, { force: true });
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
