import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { downloadFile } from "@huggingface/hub";
import { statePath } from "../workspace/state-paths.js";

/* Composer voice input's transcription engine: whisper.cpp over WAV utterances the browser records and
 * segments itself (16kHz mono s16le — the page encodes exactly what whisper-cli reads, so this side never
 * decodes audio). The whisper-cli conventions here — the ENOENT provisioning probe, one run at a time, the
 * explicit language flag, the noise-annotation cleanup — mirror the Discord voice session's transcriber
 * (_extensions/discord/src/audio.ts), which proved them; the two stay separate because an extension's gateway
 * process and the daemon cannot share code.
 *
 * whisper-cli comes from the `whisper` feature pack (packs/whisper.Dockerfile — baked into the standard image
 * profile). On an image without it, `status` reports unprovisioned and the browser explains the one-time
 * rebuild instead of recording audio nobody can hear. */

// One multilingual model for every request: the language arrives per-utterance from the browser's locale, so
// the English-specialized variants Discord picks per-connector-config would be wrong here. `large-v3-turbo`
// over `small`, measured over 60 LibriSpeech test-other utterances (the deliberately hard set): 5.8% word
// error down to 4.3% — a quarter of the remaining mistakes gone, which is the difference between dictation you
// re-read and dictation you trust. It is paid for in CPU (~3.5× per utterance: 0.7× realtime on an idle
// 16-core box and ~1.3× under load, so a 10s sentence lands in 7-13s) and in a 1.6GB first-use download
// instead of 466MB. Full `large-v3` is NOT the next rung up — on a shared sample it scored no better while
// running 2× slower again on a 3.1GB model, so turbo is the top of this curve rather than a midpoint on it.
const MODEL_FILE = "ggml-large-v3-turbo.bin";
const MODEL_REPO = "ggerganov/whisper.cpp";

// whisper-cli uses 4 threads whatever the box has, which on a 16-core sandbox left most of the speedup on the
// table: 11s of speech took 13.2s at 4 threads, 7.7s at 8, 6.7s at 16 — the knee is 8, past which hyperthreads
// contend for the same cores. Capped rather than uncapped because transcription shares the box with the agent
// whose composer asked for it.
const THREADS = Math.max(1, Math.min(8, availableParallelism()));

// A composer utterance is capped browser-side at 1 minute; 16kHz mono s16le is 32,000 bytes/s, so 2 MiB
// clears the longest legal utterance (+44B RIFF header) with room and refuses anything that isn't one.
export const MAX_UTTERANCE_WAV_BYTES = 2 * 1024 * 1024;
// The backstop on a wedged whisper, not the budget for a normal one: a full-cap utterance transcribes in ~80s
// at turbo's measured rate, and the browser's request dies at Cloudflare's ~100s origin cap long before this.
const TRANSCRIBE_TIMEOUT_MS = 120_000;

export type ExecFn = (command: string, args: string[], options: { timeout: number }) => Promise<{ stdout: string }>;
const defaultExec: ExecFn = (command, args, options) =>
    new Promise((resolve, reject) => {
        execFile(command, args, options, (error, stdout) => (error === null ? resolve({ stdout }) : reject(error)));
    });

// ENOENT on spawn ⇒ the binary isn't on PATH. Any other outcome (including a non-zero exit) means it exists.
const whisperCliMissing = async (exec: ExecFn): Promise<boolean> => {
    try {
        await exec("whisper-cli", ["--help"], { timeout: 10_000 });
        return false;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
};

// The browser sends its locale (`en-US`, `pl`); whisper-cli takes bare two-letter codes and defaults to `en`,
// silently mangling other languages — so the primary subtag is extracted and anything unusable becomes
// explicit auto-detection rather than an accidental English.
export const whisperLanguage = (locale: string | undefined): string => {
    const primary = (locale ?? "").trim().toLowerCase().split("-")[0] ?? "";
    return /^[a-z]{2,3}$/.test(primary) ? primary : "auto";
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

export type ModelState = "absent" | "downloading" | "ready";

export interface SpeechStatus {
    readonly provisioned: boolean;
    readonly model: ModelState;
}

export interface Speech {
    /** Where voice stands on this sandbox — and the download trigger: asking while the model is absent starts
     * fetching it in the background, so the browser's "Preparing voice" poll is also what prepares it. */
    readonly status: () => Promise<SpeechStatus>;
    /** One utterance's WAV → its text; empty string when whisper heard only silence/noise. */
    readonly transcribe: (wav: Buffer, locale: string | undefined) => Promise<string>;
}

// The refusals the route answers with a status of their own — anything else is a plain 500.
export class SpeechUnprovisionedError extends Error {
    constructor() {
        super("whisper-cli is not in this sandbox image — a one-time rebuild adds it");
    }
}
export class SpeechModelNotReadyError extends Error {
    constructor() {
        super("the speech model is still downloading");
    }
}

export interface SpeechDeps {
    readonly workspaceRoot: string;
    readonly log: (message: string) => void;
    readonly exec?: ExecFn;
    // The model fetch, injectable for tests. Defaults to HF's downloadFile — its CAS bridge 403s anonymous
    // plain-HTTP fetches, so this speaks the Xet protocol rather than fetch().
    readonly fetchModel?: (file: string) => Promise<Blob | null>;
}

export const createSpeech = ({ workspaceRoot, log, exec = defaultExec, fetchModel }: SpeechDeps): Speech => {
    // Under cache/ because that is what the model IS — 1.6 GB re-downloadable by content, exactly what the
    // cache entry's `derived` promises exports and the watcher. Its old top-level home is a retired dir.
    const modelPath = statePath(workspaceRoot, ".intentic/cache/", "whisper", MODEL_FILE);
    const download = fetchModel ?? ((file: string) => downloadFile({ repo: MODEL_REPO, path: file }));

    // The provisioning probe's answer, cached per process: the binary arrives via image rebuild, which
    // restarts the daemon, so neither answer can go stale within one daemon's life.
    let provisioned: Promise<boolean> | undefined;
    const isProvisioned = (): Promise<boolean> => (provisioned ??= whisperCliMissing(exec).then((missing) => !missing));

    // One download, however many status polls and transcribes ask for it. Kept in the workspace volume — same
    // directory Discord voice downloads into, so a model either feature fetched serves both.
    let downloading: Promise<void> | undefined;
    const modelReady = (): Promise<boolean> =>
        stat(modelPath).then(
            () => true,
            () => false,
        );
    const ensureModel = (): Promise<void> =>
        (downloading ??= (async () => {
            if (await modelReady()) {
                return;
            }
            log(`downloading ${MODEL_FILE} (first voice use)`);
            const blob = await download(MODEL_FILE);
            if (blob === null) {
                throw new Error(`speech model download failed: ${MODEL_REPO} has no ${MODEL_FILE}`);
            }
            await mkdir(dirname(modelPath), { recursive: true });
            // Stream straight to disk (~1.6GB — never buffer it), landing BESIDE the model and only then taking
            // its place. Growing the real file in place is what broke voice: readiness is a bare stat, so the
            // model read as "ready" the instant the empty file was created, the browser stopped waiting and
            // started recording, and every utterance spoken over the remaining minutes of download met a
            // half-written model — whisper-cli exits "failed to initialize whisper context" in 40ms and the
            // composer could only say "try again". rename is atomic within the directory, so the model is
            // either absent or whole. The staged name is unique per attempt because the Discord voice session
            // downloads into this same directory and may be fetching this same file.
            const staged = `${modelPath}.${randomUUID()}.part`;
            try {
                // hub's web ReadableStream and the DOM lib's disagree on generics — same object at runtime.
                await pipeline(Readable.fromWeb(blob.stream() as import("node:stream/web").ReadableStream), createWriteStream(staged));
                await rename(staged, modelPath);
            } catch (error) {
                await rm(staged, { force: true });
                throw error;
            }
        })()).catch((error) => {
            // A failed download must not poison every later attempt — clear the latch so the next ask retries.
            downloading = undefined;
            throw error;
        });

    // One whisper-cli run at a time — transcription is CPU-bound and the sandbox is small; utterances queue.
    let queue: Promise<unknown> = Promise.resolve();
    const serialize = <T>(job: () => Promise<T>): Promise<T> => {
        const next = queue.then(job, job);
        queue = next.catch(() => {});
        return next;
    };

    return {
        status: async () => {
            if (!(await isProvisioned())) {
                return { provisioned: false, model: "absent" };
            }
            if (await modelReady()) {
                return { provisioned: true, model: "ready" };
            }
            // Fire the download and answer immediately — the poll that asked is the poll that will see "ready".
            ensureModel().catch((error) => log(`speech model download failed: ${String(error)}`));
            return { provisioned: true, model: "downloading" };
        },
        transcribe: async (wav, locale) => {
            if (!(await isProvisioned())) {
                throw new SpeechUnprovisionedError();
            }
            // The browser only records after status said "ready", so an absent model here is a race (first-use
            // download still running), answered as such rather than by holding the request open for minutes.
            if (!(await modelReady())) {
                throw new SpeechModelNotReadyError();
            }
            return serialize(async () => {
                const wavPath = join(tmpdir(), `intentic-utterance-${randomUUID()}.wav`);
                await writeFile(wavPath, wav);
                try {
                    // whisper-cli defaults to -l en, silently mangling other languages — always pass one.
                    const { stdout } = await exec(
                        "whisper-cli",
                        ["-m", modelPath, "-f", wavPath, "-l", whisperLanguage(locale), "-t", String(THREADS), "--no-timestamps", "--no-prints"],
                        { timeout: TRANSCRIBE_TIMEOUT_MS },
                    );
                    return cleanTranscription(stdout) ?? "";
                } finally {
                    await rm(wavPath, { force: true });
                }
            });
        },
    };
};
