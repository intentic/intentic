import { z } from "zod";
import { WAKE_WORD_DEFAULT, WakeWordSchema } from "./speech.js";

// Speaking a reply aloud: which voices a sandbox can speak with, which one speaks a language, and the live wire the
// editor plays speech over. The daemon's engine is src/speech/voice; the editor's half is
// _editor/web/src/features/chat/voice. Dictation, the other direction, is schemas/speech.ts.

// Where a voice is made. `kokoro` and `piper` run on this sandbox's own CPU (sherpa-onnx, the runtime dictation already
// loads), so nothing leaves it; the rest are providers the owner connected with an API key of their own.
export const VoiceEngineSchema = z.enum(["kokoro", "piper", "elevenlabs", "cartesia", "deepgram"]);
export type VoiceEngine = z.infer<typeof VoiceEngineSchema>;

export const CloudVoiceProviderSchema = z.enum(["elevenlabs", "cartesia", "deepgram"]);
export type CloudVoiceProvider = z.infer<typeof CloudVoiceProviderSchema>;

export const isCloudVoiceEngine = (engine: VoiceEngine): engine is CloudVoiceProvider => CloudVoiceProviderSchema.safeParse(engine).success;

// A voice, as `<engine>/<name>`: `kokoro/af_heart`, `piper/pl_PL-gosia-medium`, `elevenlabs/<voice id>`. One string so a
// setting, a preview and a log line all name a voice the same way.
export const VOICE_ID = /^(kokoro|piper|elevenlabs|cartesia|deepgram)\/[\w.-]+$/u;
export const VoiceIdSchema = z.string().regex(VOICE_ID);
export type VoiceId = z.infer<typeof VoiceIdSchema>;

export const voiceEngineOf = (id: VoiceId): VoiceEngine => VoiceEngineSchema.parse(id.slice(0, id.indexOf("/")));
export const voiceNameOf = (id: VoiceId): string => id.slice(id.indexOf("/") + 1);

// A language as an ISO 639-1 primary subtag, lowercased: `en`, `pl`. Regional voices (British English, Brazilian
// Portuguese) are voices of the one language, chosen like any other.
export const VoiceLanguageSchema = z.string().regex(/^[a-z]{2,3}$/u);

// A provider the owner connected for speaking: its key stays in the sandbox's secrets, named here.
export const CloudVoiceSchema = z.object({
    provider: CloudVoiceProviderSchema.describe("Which provider speaks."),
    secret: z.string().min(1).describe("The stored secret holding its API key, by name, as the Secrets page lists it."),
    model: z.string().default("").describe("Which of its models speaks. Empty takes its fast default, the one made for conversation."),
    voice: z.string().default("").describe("Which of its voices, by the provider's own voice id. Empty takes a default that speaks the language."),
});
export type CloudVoice = z.infer<typeof CloudVoiceSchema>;

// The sandbox's speaking choices (SandboxSettings.voice).
export const VoiceSettingsSchema = z.object({
    replies: z
        .boolean()
        .default(true)
        .describe(
            "When you talk to the agent hands-free, have it answer out loud: a few spoken sentences saying what it did and what it needs from you, while the full reply stays on screen.",
        ),
    interrupt: z
        .boolean()
        .default(false)
        .describe(
            "Stop speaking the moment you start talking over it. Off, the microphone rests while a reply is spoken, which is the safe choice on speakers: a voice the browser fails to cancel would otherwise be heard as yours.",
        ),
    speed: z.number().min(0.5).max(2).default(1).describe("How fast it speaks, 1 being the voice's own pace."),
    voices: z
        .record(VoiceLanguageSchema, VoiceIdSchema)
        .default({})
        .describe(
            "Which voice speaks each language, where you picked one. A language left out is spoken by the connected provider when there is one, and otherwise by its default on this sandbox: Kokoro for the eight languages it speaks, Piper for the rest.",
        ),
    cloud: CloudVoiceSchema.optional().describe(
        "A speech provider of your own, used for every language it speaks unless you picked a voice on this sandbox for it. Its key is a stored secret; text it speaks leaves the sandbox for that provider.",
    ),
    wake: z
        .object({
            word: WakeWordSchema.default(WAKE_WORD_DEFAULT).describe(
                "The name you call the agent by. Two or three syllables wake it reliably; a short or everyday word wakes it by mistake.",
            ),
        })
        .prefault({})
        .describe(
            "Talking to the agent from across the room: say this word and what you want, on a device where listening for it is switched on. Each device is switched on by its own reader, since it is that device's microphone.",
        ),
});
export type VoiceSettings = z.infer<typeof VoiceSettingsSchema>;

// One voice the sandbox can speak with, as the settings page lists it.
export const VoiceInfoSchema = z.object({
    id: VoiceIdSchema,
    label: z.string().describe("Its name as a person would say it."),
    languages: z.array(VoiceLanguageSchema).describe("What it speaks; a regional voice lists its language."),
    accent: z.string().optional().describe("The region it sounds from, where the language has several (US, GB, BR)."),
    gender: z.enum(["female", "male"]).optional(),
    // The download a local voice's model costs, the first time anything asks it to speak; shared by every voice of
    // one model (Kokoro's 54 voices are one download).
    model: z.string().optional().describe("The model a local voice lives in."),
    bytes: z.number().optional().describe("How much that model downloads, the first time it speaks."),
    installed: z.boolean().optional().describe("Its model is on this sandbox already."),
});
export type VoiceInfo = z.infer<typeof VoiceInfoSchema>;

// GET /speech/voices: everything the settings page needs to choose.
export const VoicesViewSchema = z.object({
    voices: z.array(VoiceInfoSchema),
    // The local default for every language a local voice speaks; what speaks a language nobody chose for.
    defaults: z.record(VoiceLanguageSchema, VoiceIdSchema),
    cloud: z
        .object({
            provider: CloudVoiceProviderSchema,
            ready: z.boolean().describe("Its secret resolves, so it can be asked."),
            languages: z.array(VoiceLanguageSchema).describe("What it speaks; any other language falls back to this sandbox's voices."),
        })
        .optional(),
    provisioned: z.boolean().describe("This sandbox can run speech synthesis at all."),
});
export type VoicesView = z.infer<typeof VoicesViewSchema>;

// Where the voice that speaks a phrase stands: its model on disk, still on its way, or a provider's.
export const VoiceStatusSchema = z.object({
    voice: VoiceIdSchema,
    model: z.enum(["ready", "downloading", "absent", "failed", "cloud"]),
    received: z.number().optional().describe("Bytes of the model fetched so far, while it downloads."),
    total: z.number().optional().describe("The model's whole download, while it downloads."),
    error: z.string().optional(),
});
export type VoiceStatus = z.infer<typeof VoiceStatusSchema>;

// What a text is, so the daemon knows how to say it:
// - `plain`: words to say as they are (a preview, a question card read out, Discord).
// - `read`: a written reply read aloud whole: code is announced rather than spelled, tables and links shortened.
// - `reply`: a written reply turned into a few spoken sentences first (the `spoken-reply` job, or its first lines when
//   no model is set for it); the words chosen come back as `spoken` before they are heard.
export const SpeakAsSchema = z.enum(["plain", "read", "reply"]);
export type SpeakAs = z.infer<typeof SpeakAsSchema>;

// The longest text one utterance takes: a long reply read whole, with headroom.
export const MAX_SPOKEN_TEXT = 40_000;

// GET /speech/say, a WebSocket (one per player, many utterances): `say` opens utterance `id`, `stop` ends it (and the
// audio still queued for it is dropped). The daemon answers, per utterance, `status` while its voice's model is on
// its way, `spoken` with the words chosen (always for `reply`, so they can be shown), then pairs of `audio` (a JSON
// header) and one binary frame of that many mono s16le samples, then `done`. Utterances are spoken one at a time, in
// the order they were asked.
export const VoiceClientMessageSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("say"),
        id: z.number(),
        text: z.string().min(1).max(MAX_SPOKEN_TEXT),
        as: SpeakAsSchema.default("plain"),
        lang: z.string().optional().describe("The reader's language, a hint: the text's own language decides when it can be told."),
        voice: VoiceIdSchema.optional().describe("Speak with this voice whatever the settings say: a preview."),
        asked: z.string().max(4000).optional().describe("For `reply`: what the person asked, so the spoken answer can be in their language."),
        conversationId: z.string().optional().describe("For `reply`: the conversation it answers, for the providers allowed to read it."),
    }),
    z.object({ type: z.literal("stop"), id: z.number() }),
]);
export type VoiceClientMessage = z.infer<typeof VoiceClientMessageSchema>;

export const VoiceServerMessageSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("status"), id: z.number(), status: VoiceStatusSchema }),
    z.object({
        type: z.literal("spoken"),
        id: z.number(),
        text: z.string().describe("The words about to be said."),
        lang: VoiceLanguageSchema,
        voice: VoiceIdSchema,
    }),
    z.object({
        type: z.literal("audio"),
        id: z.number(),
        sampleRate: z.number(),
        samples: z.number().describe("How many mono s16le samples the binary frame right after this one holds."),
    }),
    z.object({ type: z.literal("done"), id: z.number() }),
    z.object({
        type: z.literal("notice"),
        id: z.number(),
        message: z.string().describe("Something worth saying that did not stop it: a provider that failed, so this sandbox's voice spoke instead."),
    }),
    z.object({ type: z.literal("error"), id: z.number().optional(), message: z.string() }),
]);
export type VoiceServerMessage = z.infer<typeof VoiceServerMessageSchema>;
