import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

// whisper.cpp's command line, run one way for the daemon's speech route and Discord voice; the contract reads its output.

export type WhisperExec = (command: string, args: string[], options: { timeout: number }) => Promise<{ stdout: string }>;

const execWhisper: WhisperExec = (command, args, options) =>
    new Promise((resolve, reject) => {
        execFile(command, args, options, (error, stdout) => (error === null ? resolve({ stdout }) : reject(error)));
    });

// ENOENT on spawn means the binary isn't on PATH; any other outcome, even a non-zero exit, means it exists.
export const whisperCliMissing = async (exec: WhisperExec = execWhisper): Promise<boolean> => {
    try {
        await exec("whisper-cli", ["--help"], { timeout: 10_000 });
        return false;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
};

// Backstop for a wedged run, not the normal budget.
const RUN_TIMEOUT_MS = 120_000;

export interface WhisperRun {
    // The ggml weights file.
    readonly model: string;
    // Passed as `-l` on every run: left out, whisper-cli assumes English and silently mangles every other language.
    readonly language: string;
    // `-t`; whisper-cli's own default when absent.
    readonly threads?: number | undefined;
    readonly exec?: WhisperExec | undefined;
}

// One 16kHz mono s16le WAV to whisper-cli's stdout, the WAV in a fresh private directory no other process can pre-plant.
export const runWhisper = async (wav: Uint8Array, { model, language, threads, exec = execWhisper }: WhisperRun): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-utterance-"));
    const wavPath = join(dir, "utterance.wav");
    try {
        await writeFile(wavPath, wav, { mode: 0o600 });
        const threadArgs = threads === undefined ? [] : ["-t", String(threads)];
        const args = ["-m", model, "-f", wavPath, "-l", language, ...threadArgs, "--no-timestamps", "--no-prints"];
        const { stdout } = await exec("whisper-cli", args, { timeout: RUN_TIMEOUT_MS });
        return stdout;
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
};

// Staged under a name unique to this attempt, then renamed: a model mid-download never reads as present, nor mixes with another's.
export const storeWhisperModel = async (path: string, model: Blob): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    const staged = `${path}.${randomUUID()}.part`;
    try {
        // The global ReadableStream and node:stream/web's are one runtime object the checker sees no overlap between.
        await pipeline(Readable.fromWeb(model.stream() as unknown as NodeReadableStream<Uint8Array>), createWriteStream(staged));
        await rename(staged, path);
    } catch (error) {
        await rm(staged, { force: true });
        throw error;
    }
};
