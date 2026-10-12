import { availableParallelism } from "node:os";
import { errorMessage } from "@intentic/base/errors";
import {
    type CloudVoiceProvider,
    isCloudVoiceEngine,
    type SpeakAs,
    type VoiceId,
    voiceEngineOf,
    voiceNameOf,
    type VoiceSettings,
    type VoicesView,
    type VoiceStatus,
} from "@intentic/sandbox-contract";
import { opt } from "../../opt.js";
import { statePath } from "../../state-paths.js";
import { runtimePresent } from "../transcribe.js";
import { CLOUD_CHUNK_CHARS, CLOUD_VOICES, type CloudVoiceAdapter, CloudVoiceError, type HttpFetch, type VoiceChunk } from "./cloud-voices.js";
import { guessLanguage } from "./voice-language.js";
import { createVoiceModelStore, type VoiceModelStore } from "./voice-model-store.js";
import { LOCAL_DEFAULTS, LOCAL_VOICES, type LocalVoice, localDefault, localVoice, voiceInfo } from "./voice-models.js";
import { createVoiceProcess, type VoiceProcess } from "./voice-process.js";
import { sentencesOf, speakableMarkdown, spokenFallback } from "./voice-text.js";

// The sandbox's voice: text in, audio out, a sentence at a time. Which voice speaks is decided per utterance from the
// text's own language and the owner's settings (schemas/voice.ts): a voice they picked for that language, else their
// connected provider where it speaks the language, else this sandbox's default for it (Kokoro for the eight languages it
// speaks, Piper for the rest). A provider that fails mid-reply hands the rest of it to the local voice and says so,
// rather than leaving the listener in silence. Serves the editor's player (voice.routes.ts) and Discord's calls.

export type { VoiceChunk } from "./cloud-voices.js";

export interface SpeakRequest {
    readonly text: string;
    readonly as: SpeakAs;
    // The reader's language, a hint the text's own language overrides when it can be told.
    readonly lang?: string | undefined;
    // A voice to speak with whatever the settings say: a preview.
    readonly voice?: VoiceId | undefined;
    // For `reply`: what the person asked, and the conversation it is in.
    readonly asked?: string | undefined;
    readonly conversationId?: string | undefined;
}

export interface SpokenWords {
    readonly text: string;
    readonly lang: string;
    readonly voice: VoiceId;
}

export interface SpeakEvents {
    // The voice's model is on its way, or a provider's: what a listener is told while nothing plays yet.
    readonly status?: (status: VoiceStatus) => void;
    // The words chosen and who says them, before the first sentence is heard.
    readonly spoken?: (words: SpokenWords) => void;
    // Something that did not stop it: a provider failed and this sandbox's voice took over.
    readonly notice?: (message: string) => void;
}

// What the `spoken-reply` job is asked: a written reply to make into a few spoken sentences, in `language`.
export interface SpokenReplyAsk {
    readonly reply: string;
    readonly asked: string | undefined;
    readonly conversationId: string | undefined;
    readonly language: string;
}

export interface Voice {
    /** Every voice there is to choose from, and what speaks a language nobody chose for. */
    readonly voices: () => Promise<VoicesView>;
    /** The text's audio, a sentence at a time, until it is said or `signal` aborts. */
    readonly speak: (request: SpeakRequest, signal: AbortSignal, events?: SpeakEvents) => AsyncGenerator<VoiceChunk>;
    readonly close: () => void;
}

export interface VoiceDeps {
    readonly workspaceRoot: string;
    readonly log: (message: string) => void;
    // Read on every utterance, so a change in the settings is heard on the next one.
    readonly settings: () => Promise<VoiceSettings>;
    // A stored secret's value by name, for a provider's key.
    readonly secret: (name: string) => Promise<string | undefined>;
    // The `spoken-reply` job; undefined (or answering undefined) when no model is set for it.
    readonly spokenReply?: (ask: SpokenReplyAsk) => Promise<string | undefined>;
    // Injectable for tests.
    readonly fetch?: HttpFetch;
    readonly process?: VoiceProcess;
    readonly store?: VoiceModelStore;
    readonly provisioned?: () => boolean;
}

// No runtime for this machine: only a new image could change it.
export class VoiceUnprovisionedError extends Error {
    constructor() {
        super(`speech synthesis has no runtime for ${process.platform}-${process.arch} in this sandbox`);
    }
}

// Two cores of however many the box has, at most four, as dictation takes: Kokoro keeps ahead of playback on two even
// on a busy box (0.4x real time, 2026-10-12), and the agents being listened to share the machine.
const THREADS = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));

// Who speaks one utterance.
type Speaker =
    | { readonly kind: "local"; readonly voice: LocalVoice }
    | {
          readonly kind: "cloud";
          readonly provider: CloudVoiceProvider;
          readonly adapter: CloudVoiceAdapter;
          readonly voice: string;
          readonly model: string;
          readonly secret: string;
      };

const speakerId = (speaker: Speaker): VoiceId =>
    speaker.kind === "local" ? speaker.voice.id : `${speaker.provider}/${speaker.voice === "" ? "default" : speaker.voice}`;

// The settings' answer for one language: the owner's pick for it, their provider where it speaks it, this sandbox's
// default otherwise. A pick naming a provider that is no longer connected, or a local voice no longer pinned, is
// passed over rather than failing the utterance.
export const speakerFor = (settings: VoiceSettings, language: string, explicit?: VoiceId): Speaker => {
    const cloud = settings.cloud;
    const chosen = explicit ?? settings.voices[language];
    if (chosen !== undefined) {
        const engine = voiceEngineOf(chosen);
        if (isCloudVoiceEngine(engine)) {
            if (cloud?.provider === engine) {
                // `<provider>/default` is the provider's own default for the language, as the settings page offers it.
                const name = voiceNameOf(chosen);
                return { kind: "cloud", provider: engine, adapter: CLOUD_VOICES[engine], voice: name === "default" ? "" : name, model: cloud.model, secret: cloud.secret };
            }
        } else {
            const local = localVoice(chosen);
            if (local !== undefined) {
                return { kind: "local", voice: local };
            }
        }
    }
    if (cloud !== undefined && CLOUD_VOICES[cloud.provider].languages.includes(language)) {
        return { kind: "cloud", provider: cloud.provider, adapter: CLOUD_VOICES[cloud.provider], voice: cloud.voice, model: cloud.model, secret: cloud.secret };
    }
    return { kind: "local", voice: localDefault(language) };
};

// Sentences grouped up to a provider request's size, in order.
const groupsOf = (sentences: readonly string[], limit: number): string[][] => {
    const groups: string[][] = [];
    let size = 0;
    for (const sentence of sentences) {
        const last = groups.at(-1);
        if (last !== undefined && size + sentence.length <= limit) {
            last.push(sentence);
            size += sentence.length + 1;
        } else {
            groups.push([sentence]);
            size = sentence.length;
        }
    }
    return groups;
};

export const createVoice = (deps: VoiceDeps): Voice => {
    const { log } = deps;
    const progress = new Set<(model: string) => void>();
    const store =
        deps.store ??
        createVoiceModelStore({
            // Under cache/, since a model is content that downloads again, like dictation's.
            cacheDir: statePath(deps.workspaceRoot, ".intentic/local/cache/", "voices"),
            log,
            onChange: (model) => {
                for (const listener of progress) {
                    listener(model);
                }
            },
        });
    const voiceProcess = deps.process ?? createVoiceProcess({ log });
    const fetchHttp: HttpFetch = deps.fetch ?? ((url, init) => fetch(url, init));

    let present: boolean | undefined;
    const isProvisioned = (): boolean => (present ??= deps.provisioned === undefined ? runtimePresent(log) : deps.provisioned());

    // The words to say and the language they are in. A reply is made short by the job when a model is set for it, by
    // its own opening lines otherwise; in the language the person asked in, so a question asked in Polish is answered
    // in Polish whatever the reply was written in.
    const wordsOf = async (request: SpeakRequest, preview: LocalVoice | undefined): Promise<{ readonly text: string; readonly language: string }> => {
        if (preview !== undefined) {
            return { text: speakableMarkdown(request.text, preview.language), language: preview.language };
        }
        const written = guessLanguage(request.text, request.lang);
        if (request.as !== "reply") {
            return { text: speakableMarkdown(request.text, written), language: written };
        }
        const language = request.asked === undefined ? written : guessLanguage(request.asked, written);
        const composed = await deps
            .spokenReply?.({ reply: request.text, asked: request.asked, conversationId: request.conversationId, language })
            .catch((error: Error) => {
                log(`the spoken-reply job failed, saying the reply's opening instead: ${errorMessage(error)}`);
                return undefined;
            });
        const text = composed ?? spokenFallback(request.text, written);
        return { text, language: guessLanguage(text, language) };
    };

    // The model on disk, telling the listener how its download goes while they wait for the first word.
    const modelDir = async (voice: LocalVoice, events: SpeakEvents): Promise<string> => {
        const state = await store.state(voice.model);
        if (state.state === "ready") {
            return state.dir;
        }
        const tell = async (model: string): Promise<void> => {
            if (model !== voice.model.id) {
                return;
            }
            const now = await store.state(voice.model);
            if (now.state === "downloading") {
                events.status?.({ voice: voice.id, model: "downloading", received: now.received, total: now.total });
            }
        };
        const listener = (model: string): void => void tell(model);
        progress.add(listener);
        events.status?.({ voice: voice.id, model: "downloading", received: 0, total: voice.model.bytes });
        try {
            return await store.ensure(voice.model);
        } finally {
            progress.delete(listener);
        }
    };

    async function* speakLocal(voice: LocalVoice, sentences: readonly string[], speed: number, signal: AbortSignal, events: SpeakEvents): AsyncGenerator<VoiceChunk> {
        if (!isProvisioned()) {
            throw new VoiceUnprovisionedError();
        }
        const dir = await modelDir(voice, events);
        const spec = { kind: voice.model.kind, model: voice.model.id, dir, threads: THREADS };
        for (const sentence of sentences) {
            if (signal.aborted) {
                return;
            }
            yield await voiceProcess.say(spec, { text: sentence, sid: voice.sid, speed, ...opt("lang", voice.kokoroLang) });
        }
    }

    // A provider's audio, a request per group of sentences; `done` counts the sentences fully spoken, so a failure part
    // way through hands only the rest to the local voice.
    async function* speakCloud(
        speaker: Extract<Speaker, { kind: "cloud" }>,
        sentences: readonly string[],
        language: string,
        speed: number,
        signal: AbortSignal,
        done: { count: number },
    ): AsyncGenerator<VoiceChunk> {
        const key = await deps.secret(speaker.secret);
        if (key === undefined || key === "") {
            throw new CloudVoiceError(`the secret ${speaker.secret} holding the ${speaker.adapter.label} key is not stored`);
        }
        for (const group of groupsOf(sentences, CLOUD_CHUNK_CHARS)) {
            if (signal.aborted) {
                return;
            }
            yield* speaker.adapter.speak({ text: group.join(" "), language, voice: speaker.voice, model: speaker.model, speed, key, signal }, fetchHttp);
            done.count += group.length;
        }
    }

    return {
        voices: async () => {
            const settings = await deps.settings();
            const installed = new Map<string, boolean>();
            for (const voice of LOCAL_VOICES) {
                if (!installed.has(voice.model.id)) {
                    installed.set(voice.model.id, (await store.state(voice.model)).state === "ready");
                }
            }
            const cloud = settings.cloud;
            const key = cloud === undefined ? undefined : await deps.secret(cloud.secret);
            return {
                voices: LOCAL_VOICES.map((voice) => voiceInfo(voice, installed.get(voice.model.id))),
                defaults: { ...LOCAL_DEFAULTS },
                ...opt(
                    "cloud",
                    cloud === undefined
                        ? undefined
                        : { provider: cloud.provider, ready: key !== undefined && key !== "", languages: [...CLOUD_VOICES[cloud.provider].languages] },
                ),
                provisioned: isProvisioned(),
            };
        },
        async *speak (request, signal, events = {}) {
            const settings = await deps.settings();
            const preview = request.voice === undefined ? undefined : localVoice(request.voice);
            const words = await wordsOf(request, preview);
            if (words.text === "" || signal.aborted) {
                return;
            }
            let speaker = speakerFor(settings, words.language, request.voice);
            events.spoken?.({ text: words.text, lang: words.language, voice: speakerId(speaker) });
            let sentences = sentencesOf(words.text);
            if (speaker.kind === "cloud") {
                events.status?.({ voice: speakerId(speaker), model: "cloud" });
                const done = { count: 0 };
                try {
                    yield* speakCloud(speaker, sentences, words.language, settings.speed, signal, done);
                    return;
                } catch (error) {
                    if (signal.aborted) {
                        return;
                    }
                    const message = errorMessage(error);
                    log(`${speaker.adapter.label} could not speak, this sandbox's voice takes over: ${message}`);
                    events.notice?.(`${speaker.adapter.label} could not speak (${message}), so this sandbox's own voice is speaking instead.`);
                    sentences = sentences.slice(done.count);
                    speaker = { kind: "local", voice: localDefault(words.language) };
                }
            }
            yield* speakLocal(speaker.voice, sentences, settings.speed, signal, events);
        },
        close: () => voiceProcess.close(),
    };
};
