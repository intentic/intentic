import { availableParallelism } from "node:os";
import { pathExists } from "@intentic/base/fs";
import { runWhisper, storeWhisperModel, type WhisperExec, whisperCliMissing } from "@intentic/base/whisper";
import { cleanTranscription, WHISPER_MODEL_REPO } from "@intentic/sandbox-contract";
import { downloadFile } from "@huggingface/hub";
import { statePath } from "../state-paths.js";

// whisper.cpp over WAV utterances the browser segments, run as Discord voice runs it; an image without the `whisper` pack reports unprovisioned.

// One multilingual model for every request, since language arrives per-utterance from the browser's locale.
const MODEL_FILE = "ggml-large-v3-turbo.bin";

// Capped at 8 regardless of core count; transcription shares the box with the requesting agent.
const THREADS = Math.max(1, Math.min(8, availableParallelism()));

// Covers the longest legal utterance (1 min at 16kHz mono s16le) with headroom; refuses anything longer.
export const MAX_UTTERANCE_WAV_BYTES = 2 * 1024 * 1024;

// whisper-cli takes a bare two-letter code and silently defaults to `en`; the primary subtag is extracted, and anything
// unusable becomes explicit `auto` rather than an accidental English.
export const whisperLanguage = (locale: string | undefined): string => {
    const primary = (locale ?? "").trim().toLowerCase().split("-")[0] ?? "";
    return /^[a-z]{2,3}$/.test(primary) ? primary : "auto";
};

export type ModelState = "absent" | "downloading" | "ready";

export interface SpeechStatus {
    readonly provisioned: boolean;
    readonly model: ModelState;
}

export interface Speech {
/** Where voice stands on this sandbox; asking while the model is absent starts fetching it, so the polling itself is what prepares it. */
    readonly status: () => Promise<SpeechStatus>;
    /** One utterance's WAV to text; empty string when whisper heard only silence or noise. */
    readonly transcribe: (wav: Buffer, locale: string | undefined) => Promise<string>;
}

// Refusals the route answers with a status of their own; anything else is a plain 500.
export class SpeechUnprovisionedError extends Error {
    constructor() {
        super("whisper-cli is not in this sandbox image: a one-time rebuild adds it");
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
    readonly exec?: WhisperExec;
    // Injectable for tests; defaults to HF's downloadFile, since plain HTTP fetches get 403'd by the CAS bridge.
    readonly fetchModel?: (file: string) => Promise<Blob | null>;
}

export const createSpeech = ({ workspaceRoot, log, exec, fetchModel }: SpeechDeps): Speech => {
    // Under cache/, since the model is content-re-downloadable, like anything else the `derived` cache promises.
    const modelPath = statePath(workspaceRoot, ".intentic/local/cache/", "whisper", MODEL_FILE);
    const download = fetchModel ?? ((file: string) => downloadFile({ repo: WHISPER_MODEL_REPO, path: file }));

    // Cached per process: the binary only arrives via an image rebuild, which restarts the daemon anyway.
    let provisioned: Promise<boolean> | undefined;
    const isProvisioned = (): Promise<boolean> => (provisioned ??= whisperCliMissing(exec).then((missing) => !missing));

    // One download regardless of callers; shares Discord voice's download directory, so either fetch serves both.
    let downloading: Promise<void> | undefined;
    const modelReady = (): Promise<boolean> => pathExists(modelPath);
    const ensureModel = (): Promise<void> =>
        (downloading ??= (async () => {
            if (await modelReady()) {
                return;
            }
            log(`downloading ${MODEL_FILE} (first voice use)`);
            const blob = await download(MODEL_FILE);
            if (blob === null) {
                throw new Error(`speech model download failed: ${WHISPER_MODEL_REPO} has no ${MODEL_FILE}`);
            }
            // Staged, never grown in place: readiness is an existence check, which a partial model would pass.
            await storeWhisperModel(modelPath, blob);
        })()).catch((error) => {
            // A failed download must not poison every later attempt; clearing the latch lets the next ask retry.
            downloading = undefined;
            throw error;
        });

    // One whisper-cli run at a time: transcription is CPU-bound and the sandbox is small; utterances queue.
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
            // Fires the download and answers immediately; the poll that asked is the poll that will see "ready".
            ensureModel().catch((error) => log(`speech model download failed: ${String(error)}`));
            return { provisioned: true, model: "downloading" };
        },
        transcribe: async (wav, locale) => {
            if (!(await isProvisioned())) {
                throw new SpeechUnprovisionedError();
            }
            // Browser only records after status says "ready"; an absent model here is a race, answered as such.
            if (!(await modelReady())) {
                throw new SpeechModelNotReadyError();
            }
            return serialize(
                async () =>
                    cleanTranscription(await runWhisper(wav, { model: modelPath, language: whisperLanguage(locale), threads: THREADS, exec })) ?? "",
            );
        },
    };
};
