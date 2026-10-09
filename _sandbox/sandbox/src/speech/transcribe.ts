import { availableParallelism } from "node:os";
import { createRequire } from "node:module";
import { rm } from "node:fs/promises";
import { errorMessage } from "@intentic/base/errors";
import { type SpeechEngine, speechEngineFor, speechLanguage, type SpeechStatus } from "@intentic/sandbox-contract";
import { statePath } from "../state-paths.js";
import { createModelStore, type FetchLike, type ModelStore } from "./model-store.js";
import { createSpeechProcess, type SpeechProcess } from "./speech-engine.js";
import type { RecognizerSpec } from "./speech-recognizers.js";
import { BAKED_SPEECH_MODELS_DIR, modelBytes, SPEECH_MODELS } from "./speech-models.js";
import { wavSamples } from "./wav.js";

// The sandbox's dictation: a phrase of audio in, its words out, heard on this machine. Parakeet hears the 25 European
// languages it knows and is baked into the standard image; Whisper hears the rest and is fetched the first time one is
// asked for. Serves the composer (speech.routes.ts, its HTTP door and its live stream) and Discord's voice calls.

// Two cores of however many the box has, at most four: a phrase takes a fraction of a second at that, and the agents
// the person is talking to share the machine.
const THREADS = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));

// The longest utterance the WAV door takes: a minute at 16 kHz mono s16le, with headroom for the header.
export const MAX_UTTERANCE_WAV_BYTES = 2 * 1024 * 1024;

export interface Speech {
    /** Where voice stands for this locale. Asking while its model is absent starts fetching it, so an older composer's poll still prepares it. */
    readonly status: (locale: string | undefined) => Promise<SpeechStatus>;
    /** Fetch the locale's model if it is missing and load it into memory, in the background; answers the status now. */
    readonly prepare: (locale: string | undefined) => Promise<SpeechStatus>;
    /** One WAV utterance to its text; empty when it held no words. Refuses while the model is not on disk yet. */
    readonly transcribe: (wav: Buffer, locale: string | undefined) => Promise<string>;
    /** One phrase of 16 kHz mono samples to its text, waiting for the model however long it takes to arrive. */
    readonly hear: (samples: Float32Array, locale: string | undefined) => Promise<string>;
    /** Whether a running guess at this locale's unfinished phrase is worth making, now: its model guesses cheaply and is idle. */
    readonly guessable: (locale: string | undefined) => boolean;
    /** Told whenever a status could have moved: a fetch's progress, a model loaded or let go. */
    readonly subscribe: (listener: () => void) => () => void;
    readonly close: () => void;
}

// Refusals the routes answer with a status of their own; anything else is a plain 500.
export class SpeechUnprovisionedError extends Error {
    constructor() {
        super(`speech recognition has no runtime for ${process.platform}-${process.arch} in this sandbox`);
    }
}
export class SpeechModelNotReadyError extends Error {
    constructor() {
        super("the speech model is still downloading");
    }
}

// What Whisper is known to write over silence and noise it was trained on subtitles of: the words of a video's last
// frame, which no dictated phrase is. Matched whole, case and punctuation aside.
const WHISPER_PHANTOMS = new Set([
    "thank you",
    "thanks for watching",
    "thank you for watching",
    "thank you very much",
    "subtitles by the amaraorg community",
    "dziękuję za oglądanie",
    "dziękuje za oglądanie",
    "untertitel im auftrag des zdf für funk 2017",
    "sous-titres réalisés par la communauté damaraorg",
    "продолжение следует",
    "ご視聴ありがとうございました",
    "请不吝点赞 订阅 转发 打赏支持明镜与点点栏目",
]);

const phantomKey = (text: string): string =>
    text
        .toLowerCase()
        .replaceAll(/[.,!?;:"'„”«»…。、！？]/gu, "")
        .replaceAll(/\s+/gu, " ")
        .trim();

// The words as a message would carry them: Whisper's bracketed narration of non-speech (`[BLANK_AUDIO]`, `(music)`) and
// its phantom sign-offs are not something the person said.
export const spokenText = (engine: SpeechEngine, raw: string): string => {
    const text = raw.replaceAll(/\s+/gu, " ").trim();
    if (engine !== "whisper") {
        return text;
    }
    const words = text.replaceAll(/[[(][^\])]*[\])]/gu, "").trim();
    return words === "" || WHISPER_PHANTOMS.has(phantomKey(words)) ? "" : words;
};

// Whether sherpa-onnx ships a binary for this machine; only a new image could change the answer. A package that is not
// there is the expected no; anything else is still a no, since nothing could load it, but said in the log.
const runtimePresent = (log: (message: string) => void): boolean => {
    try {
        const require = createRequire(import.meta.url);
        createRequire(require.resolve("sherpa-onnx-node")).resolve(`sherpa-onnx-${process.platform}-${process.arch}/package.json`);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") {
            log(`could not tell whether the speech runtime is installed: ${errorMessage(error)}`);
        }
        return false;
    }
};

export interface SpeechDeps {
    readonly workspaceRoot: string;
    readonly log: (message: string) => void;
    // Injectable for tests: where the image bakes models, how files are fetched, the speech process, the runtime check.
    readonly bakedDir?: string;
    readonly fetch?: FetchLike;
    readonly process?: (onChange: () => void) => SpeechProcess;
    readonly provisioned?: () => boolean;
}

export const createSpeech = ({
    workspaceRoot,
    log,
    bakedDir = BAKED_SPEECH_MODELS_DIR,
    fetch,
    process: makeProcess,
    provisioned,
}: SpeechDeps): Speech => {
    const listeners = new Set<() => void>();
    const changed = (): void => {
        for (const listener of listeners) {
            listener();
        }
    };
    // Under cache/, since a model is content that downloads again, like anything else the `derived` cache promises.
    const store: ModelStore = createModelStore({
        bakedDir,
        cacheDir: statePath(workspaceRoot, ".intentic/local/cache/", "speech"),
        log,
        onChange: changed,
        ...(fetch === undefined ? {} : { fetch }),
    });
    const speechProcess = makeProcess?.(changed) ?? createSpeechProcess({ log, onChange: changed });

    // whisper.cpp's model from before this engine: 1.6 GB per sandbox nothing reads any more.
    void rm(statePath(workspaceRoot, ".intentic/local/cache/", "whisper"), { recursive: true, force: true }).catch((error: unknown) =>
        log(`could not remove the retired whisper.cpp models: ${errorMessage(error)}`),
    );

    let present: boolean | undefined;
    const isProvisioned = (): boolean => (present ??= provisioned === undefined ? runtimePresent(log) : provisioned());

    const specFor = (engine: SpeechEngine, dir: string, locale: string | undefined): RecognizerSpec => {
        const language = engine === "whisper" ? speechLanguage(locale) : undefined;
        return { engine, dir, threads: THREADS, ...(language === undefined ? {} : { language }) };
    };

    const statusOf = async (engine: SpeechEngine): Promise<SpeechStatus> => {
        if (!isProvisioned()) {
            return { provisioned: false, model: "absent", engine };
        }
        const model = await store.state(SPEECH_MODELS[engine]);
        switch (model.state) {
            case "ready":
                return { provisioned: true, model: "ready", engine, loaded: speechProcess.loaded(engine) };
            case "downloading":
                return { provisioned: true, model: "downloading", engine, received: model.received, total: model.total };
            case "failed":
                return { provisioned: true, model: "failed", engine, error: model.error };
            default:
                return { provisioned: true, model: "absent", engine };
        }
    };

    // Fetches in the background, reported through status and `subscribe`; a failure is the status's to tell.
    const fetchInBackground = (engine: SpeechEngine): Promise<string | undefined> =>
        // allow(silent-catch): the model store logs a failed fetch and keeps its error for the status to report
        store.ensure(SPEECH_MODELS[engine]).catch(() => undefined);

    const hear = async (samples: Float32Array, locale: string | undefined): Promise<string> => {
        if (!isProvisioned()) {
            throw new SpeechUnprovisionedError();
        }
        const engine = speechEngineFor(locale);
        const dir = await store.ensure(SPEECH_MODELS[engine]);
        return spokenText(engine, await speechProcess.decode(specFor(engine, dir, locale), samples));
    };

    return {
        status: async (locale) => {
            const engine = speechEngineFor(locale);
            const status = await statusOf(engine);
            if (status.provisioned && status.model === "absent") {
                void fetchInBackground(engine);
                return { ...status, model: "downloading", received: 0, total: modelBytes(SPEECH_MODELS[engine]) };
            }
            return status;
        },
        prepare: async (locale) => {
            const engine = speechEngineFor(locale);
            if (isProvisioned()) {
                void (async () => {
                    const dir = await fetchInBackground(engine);
                    if (dir === undefined) {
                        return;
                    }
                    try {
                        await speechProcess.load(specFor(engine, dir, locale));
                    } catch (error) {
                        log(`loading the ${engine} speech model failed: ${errorMessage(error)}`);
                    }
                })();
            }
            return statusOf(engine);
        },
        transcribe: async (wav, locale) => {
            if (!isProvisioned()) {
                throw new SpeechUnprovisionedError();
            }
            const engine = speechEngineFor(locale);
            if ((await store.state(SPEECH_MODELS[engine])).state !== "ready") {
                void fetchInBackground(engine);
                throw new SpeechModelNotReadyError();
            }
            return hear(wavSamples(wav), locale);
        },
        hear,
        guessable: (locale) => {
            const engine = speechEngineFor(locale);
            return SPEECH_MODELS[engine].partials && speechProcess.loaded(engine) && !speechProcess.busy();
        },
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        close: () => speechProcess.close(),
    };
};
