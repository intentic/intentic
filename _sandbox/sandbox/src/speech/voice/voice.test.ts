import { type VoiceSettings, VoiceSettingsSchema, type VoiceStatus } from "@intentic/sandbox-contract";
import type { HttpFetch, VoiceChunk } from "./cloud-voices.js";
import type { VoiceModelState, VoiceModelStore } from "./voice-model-store.js";
import type { VoiceProcess } from "./voice-process.js";
import type { SynthAsk, SynthSpec } from "./voice-synth.js";
import { createVoice, type SpeakEvents, type SpeakRequest, speakerFor, type SpokenReplyAsk, type SpokenWords, type VoiceDeps, VoiceUnprovisionedError } from "./voice.js";

/* The voice facade over its seams: a fake voice process standing in for the models, a fake model store, a fake
   provider. What it pins is who speaks which language, what words a reply becomes, and that a provider failing part
   way through hands the rest to this sandbox's own voice rather than going quiet. */

const settingsOf = (fields: Partial<VoiceSettings> = {}): VoiceSettings => ({ ...VoiceSettingsSchema.parse({}), ...fields });

describe("speakerFor", () => {
    test("a language nobody chose for is Kokoro where Kokoro speaks it, Piper elsewhere", () => {
        expect(speakerFor(settingsOf(), "en")).toMatchObject({ kind: "local", voice: { id: "kokoro/af_heart" } });
        expect(speakerFor(settingsOf(), "pl")).toMatchObject({ kind: "local", voice: { id: "piper/pl_PL-gosia-medium" } });
        expect(speakerFor(settingsOf(), "tlh")).toMatchObject({ kind: "local", voice: { id: "kokoro/af_heart" } });
    });
    test("the owner's pick for a language wins", () => {
        expect(speakerFor(settingsOf({ voices: { pl: "piper/pl_PL-darkman-medium" } }), "pl")).toMatchObject({ voice: { id: "piper/pl_PL-darkman-medium" } });
    });
    test("a connected provider speaks the languages it knows, and only those", () => {
        const settings = settingsOf({ cloud: { provider: "deepgram", secret: "DG", model: "", voice: "" } });
        expect(speakerFor(settings, "de")).toMatchObject({ kind: "cloud", provider: "deepgram", secret: "DG" });
        expect(speakerFor(settings, "pl")).toMatchObject({ kind: "local", voice: { id: "piper/pl_PL-gosia-medium" } });
    });
    test("a pick naming a provider that is no longer connected is passed over", () => {
        expect(speakerFor(settingsOf({ voices: { en: "elevenlabs/abc" } }), "en")).toMatchObject({ kind: "local", voice: { id: "kokoro/af_heart" } });
    });
    test("`<provider>/default` is the provider's own voice", () => {
        const settings = settingsOf({ cloud: { provider: "elevenlabs", secret: "EL", model: "", voice: "v" }, voices: { en: "elevenlabs/default" } });
        expect(speakerFor(settings, "en")).toMatchObject({ kind: "cloud", voice: "" });
    });
});

// A process that "speaks" a tenth of a second per character, and records each sentence it was asked.
const fakeProcess = () => {
    const said: { readonly spec: SynthSpec; readonly ask: SynthAsk }[] = [];
    const process: VoiceProcess = {
        load: async () => {},
        say: async (spec, ask) => {
            said.push({ spec, ask });
            return { samples: new Float32Array(ask.text.length * 2_400), sampleRate: 24_000 };
        },
        loaded: () => true,
        close: () => {},
    };
    return { said, process };
};

const readyStore = (states: Partial<Record<string, VoiceModelState>> = {}): VoiceModelStore => ({
    state: async (model) => states[model.id] ?? { state: "ready", dir: `/models/${model.id}` },
    ensure: async (model) => `/models/${model.id}`,
});

const voiceWith = (overrides: Partial<VoiceDeps>) =>
    createVoice({
        workspaceRoot: "/tmp/voice-test",
        log: () => {},
        settings: async () => settingsOf(),
        secret: async () => undefined,
        store: readyStore(),
        provisioned: () => true,
        ...overrides,
    });

interface Heard {
    readonly chunks: VoiceChunk[];
    readonly spoken: SpokenWords[];
    readonly notices: string[];
    readonly statuses: VoiceStatus[];
}

const listen = async (voice: ReturnType<typeof createVoice>, request: SpeakRequest, signal = new AbortController().signal): Promise<Heard> => {
    const heard: Heard = { chunks: [], spoken: [], notices: [], statuses: [] };
    const events: SpeakEvents = {
        spoken: (words) => heard.spoken.push(words),
        notice: (message) => heard.notices.push(message),
        status: (status) => heard.statuses.push(status),
    };
    for await (const chunk of voice.speak(request, signal, events)) {
        heard.chunks.push(chunk);
    }
    return heard;
};

describe("createVoice", () => {
    test("reads a reply aloud a sentence at a time, in the voice of its own language", async () => {
        const { said, process } = fakeProcess();
        const heard = await listen(voiceWith({ process }), {
            text: "Gotowe. Formularz logowania odrzuca teraz puste hasło.\n\n```\nkod\n```\n\nCzy to ma zostać tak jak jest?",
            as: "read",
            lang: "en-US",
        });
        expect(heard.spoken).toEqual([
            {
                text: "Gotowe. Formularz logowania odrzuca teraz puste hasło. Kod, 1 linia. Czy to ma zostać tak jak jest?",
                lang: "pl",
                voice: "piper/pl_PL-gosia-medium",
            },
        ]);
        expect(said.map(({ ask }) => ask.text)).toEqual(["Gotowe. Formularz logowania odrzuca teraz puste hasło.", "Kod, 1 linia. Czy to ma zostać tak jak jest?"]);
        expect(said.every(({ spec }) => spec.kind === "piper" && spec.dir === "/models/vits-piper-pl_PL-gosia-medium")).toBe(true);
        expect(heard.chunks).toHaveLength(2);
    });

    test("tells Kokoro which language to read a non-English voice in", async () => {
        const { said, process } = fakeProcess();
        await listen(voiceWith({ process }), { text: "Listo. El formulario de inicio de sesión ahora rechaza una contraseña vacía.", as: "plain" });
        expect(said[0]).toMatchObject({ spec: { kind: "kokoro" }, ask: { sid: 28, lang: "es" } });
    });

    test("a reply is the spoken-reply job's words, in the language the person asked in", async () => {
        const { said, process } = fakeProcess();
        const asked: SpokenReplyAsk[] = [];
        const voice = voiceWith({
            process,
            spokenReply: async (ask) => {
                asked.push(ask);
                return "Formularz już odrzuca puste hasło. Czy zablokowane konto ma mieć osobny komunikat?";
            },
        });
        const heard = await listen(voice, {
            text: "Done. The login form now rejects an empty password.",
            as: "reply",
            asked: "Popraw formularz logowania, żeby nie wysyłał pustego hasła",
            conversationId: "c-1",
        });
        expect(asked).toEqual([
            {
                reply: "Done. The login form now rejects an empty password.",
                asked: "Popraw formularz logowania, żeby nie wysyłał pustego hasła",
                conversationId: "c-1",
                language: "pl",
            },
        ]);
        expect(heard.spoken[0]).toMatchObject({ lang: "pl", voice: "piper/pl_PL-gosia-medium" });
        expect(said.map(({ ask }) => ask.text).join(" ")).toBe("Formularz już odrzuca puste hasło. Czy zablokowane konto ma mieć osobny komunikat?");
    });

    test("with no model for the job, or one that fails, a reply is its own opening words", async () => {
        for (const spokenReply of [async () => undefined, async () => { throw new Error("spent"); }]) {
            const { said, process } = fakeProcess();
            await listen(voiceWith({ process, spokenReply }), { text: "Done, the tests pass.\n\n- detail one\n- detail two", as: "reply" });
            expect(said.map(({ ask }) => ask.text)).toEqual(["Done, the tests pass."]);
        }
    });

    test("a provider that fails part way through hands the rest to this sandbox's voice, and says so", async () => {
        const { said, process } = fakeProcess();
        let requests = 0;
        const fetch: HttpFetch = async () => {
            requests += 1;
            return requests === 1 ? new Response(new Uint8Array(4_800), { status: 200 }) : new Response("no credits", { status: 402 });
        };
        const long = Array.from({ length: 24 }, (_, index) => `This is a sentence numbered ${index} of a long reply, with words in it to fill the request up.`).join(" ");
        const heard = await listen(
            voiceWith({
                process,
                fetch,
                settings: async () => settingsOf({ cloud: { provider: "elevenlabs", secret: "EL", model: "", voice: "" } }),
                secret: async (name) => (name === "EL" ? "key" : undefined),
            }),
            { text: long, as: "plain" },
        );
        expect(requests).toBe(2);
        expect(heard.spoken[0]?.voice).toBe("elevenlabs/default");
        expect(heard.notices).toHaveLength(1);
        expect(heard.notices[0]).toContain("ElevenLabs");
        // The first request's sentences were heard from the provider; only the rest are spoken here.
        expect(said.length).toBeGreaterThan(0);
        expect(said[0]!.ask.text).not.toContain("numbered 0 ");
        expect(said.at(-1)!.ask.text).toContain("numbered 23 ");
    });

    test("a provider whose key is not stored never leaves the listener in silence", async () => {
        const { said, process } = fakeProcess();
        const heard = await listen(
            voiceWith({ process, settings: async () => settingsOf({ cloud: { provider: "cartesia", secret: "MISSING", model: "", voice: "" } }) }),
            { text: "The tests pass now.", as: "plain" },
        );
        expect(heard.notices[0]).toContain("MISSING");
        expect(said.map(({ ask }) => ask.text)).toEqual(["The tests pass now."]);
    });

    test("a preview speaks with the voice it names, whatever the text's language", async () => {
        const { said, process } = fakeProcess();
        await listen(voiceWith({ process }), { text: "Hello there, this is how I sound.", as: "plain", voice: "piper/de_DE-thorsten-medium" });
        expect(said[0]?.spec.model).toBe("vits-piper-de_DE-thorsten-medium");
    });

    test("a voice whose model is still on its way says how far it got before the first word", async () => {
        const { process } = fakeProcess();
        const store = readyStore({ "kokoro-multi-lang-v1_0": { state: "absent" } });
        const heard = await listen(voiceWith({ process, store }), { text: "Ready when you are.", as: "plain" });
        expect(heard.statuses[0]).toMatchObject({ voice: "kokoro/af_heart", model: "downloading", received: 0 });
        expect(heard.chunks).toHaveLength(1);
    });

    test("a stop ends it between sentences", async () => {
        const { said, process } = fakeProcess();
        const stop = new AbortController();
        const voice = voiceWith({ process });
        let chunks = 0;
        for await (const _ of voice.speak({ text: "One sentence here, said first. Then another one after it. And a third one too.", as: "plain" }, stop.signal)) {
            chunks += 1;
            stop.abort();
        }
        expect(chunks).toBe(1);
        expect(said).toHaveLength(1);
    });

    test("a machine with no runtime refuses rather than pretending to speak", async () => {
        const { process } = fakeProcess();
        const failure = await listen(voiceWith({ process, provisioned: () => false }), { text: "Hello.", as: "plain" }).catch((error: Error) => error);
        expect(failure).toBeInstanceOf(VoiceUnprovisionedError);
    });

    test("lists every local voice with what is installed, and a connected provider with whether its key resolves", async () => {
        const voice = voiceWith({
            store: readyStore({ "kokoro-multi-lang-v1_0": { state: "absent" } }),
            settings: async () => settingsOf({ cloud: { provider: "elevenlabs", secret: "EL", model: "", voice: "" } }),
            secret: async () => "key",
        });
        const view = await voice.voices();
        expect(view.voices.find((info) => info.id === "kokoro/af_heart")).toMatchObject({ installed: false, languages: ["en"], accent: "US" });
        expect(view.voices.find((info) => info.id === "piper/pl_PL-gosia-medium")).toMatchObject({ installed: true, languages: ["pl"] });
        expect(view.defaults["pl"]).toBe("piper/pl_PL-gosia-medium");
        expect(view.cloud).toMatchObject({ provider: "elevenlabs", ready: true });
        expect(view.cloud?.languages).toContain("pl");
    });
});
