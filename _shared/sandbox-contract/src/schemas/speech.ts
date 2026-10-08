import { z } from "zod";

// Dictation on this sandbox: which local model hears a language, how far it is from ready, and the live wire the
// composer streams a spoken phrase over. The daemon's engine is src/speech; the composer's half is
// _editor/web/src/features/chat/composer/voice.

// The models a sandbox can hear with, by what they are for:
// - `parakeet` (NVIDIA Parakeet TDT 0.6B v3): 25 European languages, punctuated, ~30x faster than real time on two
//   cores. Baked into the standard image, and the default for any language it covers.
// - `whisper` (OpenAI Whisper large-v3-turbo): the other ~75 languages, slower, fetched the first time one is asked for.
export const SpeechEngineSchema = z.enum(["parakeet", "whisper"]);
export type SpeechEngine = z.infer<typeof SpeechEngineSchema>;

// The 25 Parakeet hears, as ISO 639-1 primary subtags: it detects which on its own, so a browser in English and a
// speaker in Polish still land on it.
export const PARAKEET_LANGUAGES: ReadonlySet<string> = new Set([
    "bg",
    "cs",
    "da",
    "de",
    "el",
    "en",
    "es",
    "et",
    "fi",
    "fr",
    "hr",
    "hu",
    "it",
    "lt",
    "lv",
    "mt",
    "nl",
    "pl",
    "pt",
    "ro",
    "ru",
    "sk",
    "sl",
    "sv",
    "uk",
]);

// A locale's primary subtag, lowercased, or undefined for anything that is not one (`""`, `*`, `auto`).
export const speechLanguage = (locale: string | undefined): string | undefined => {
    const primary = (locale ?? "").trim().toLowerCase().split(/[-_]/u)[0] ?? "";
    return /^[a-z]{2,3}$/u.test(primary) && primary !== "auto" ? primary : undefined;
};

// Which model hears a locale: Parakeet for its own languages and for anything unreadable, Whisper for the rest.
export const speechEngineFor = (locale: string | undefined): SpeechEngine => {
    const language = speechLanguage(locale);
    return language === undefined || PARAKEET_LANGUAGES.has(language) ? "parakeet" : "whisper";
};

export const SpeechStatusSchema = z.object({
    provisioned: z.boolean().describe("This sandbox can run speech recognition at all."),
    model: z
        .enum(["absent", "downloading", "ready", "failed"])
        .describe("Whether the model for the asked language is on disk: baked into the image, fetched, being fetched, or its fetch failed."),
    engine: SpeechEngineSchema.optional().describe("Which model hears the asked language."),
    loaded: z.boolean().optional().describe("The model is in memory, so the next phrase is heard without a load first."),
    received: z.number().optional().describe("Bytes of the model fetched so far, while it downloads."),
    total: z.number().optional().describe("The model's whole size in bytes, while it downloads."),
    error: z.string().optional().describe("Why the last fetch failed, when it did."),
});
export type SpeechStatus = z.infer<typeof SpeechStatusSchema>;

// GET /speech/stream, a WebSocket: the composer cuts the microphone into phrases itself (its silence segmenter) and
// streams each one as it is spoken. A text frame `begin` opens phrase `id`; binary frames that follow are its audio,
// 16 kHz mono s16le; `end` closes it, keeping its first `keep` samples (the trailing pause trimmed off); `drop`
// abandons it. The daemon answers with `partial` text while the phrase is still being spoken, one `final` per ended
// phrase, in order, and `status` whenever the model's readiness moves. The language is the socket's `lang` query.
export const SpeechClientMessageSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("begin"), id: z.number() }),
    z.object({ type: z.literal("end"), id: z.number(), keep: z.number() }),
    z.object({ type: z.literal("drop"), id: z.number() }),
]);
export type SpeechClientMessage = z.infer<typeof SpeechClientMessageSchema>;

export const SpeechServerMessageSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("status"), status: SpeechStatusSchema }),
    z.object({ type: z.literal("partial"), id: z.number(), text: z.string() }),
    z.object({
        type: z.literal("final"),
        id: z.number(),
        text: z.string().describe("Empty when the phrase held no words."),
        decodeMs: z.number().describe("How long hearing it took once its audio was in."),
    }),
    z.object({ type: z.literal("error"), id: z.number().optional(), message: z.string() }),
]);
export type SpeechServerMessage = z.infer<typeof SpeechServerMessageSchema>;

// The longest phrase either door takes: a minute at 16 kHz. The composer's segmenter cuts a monologue at the same
// length, so nothing it sends is ever refused.
export const MAX_SPEECH_SAMPLES = 60 * 16_000;
