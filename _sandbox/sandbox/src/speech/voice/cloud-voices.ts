import type { CloudVoiceProvider } from "@intentic/sandbox-contract";

// The speech providers an owner can connect with a key of their own, each asked over plain HTTPS for raw 16-bit PCM so
// its audio streams to the listener as it arrives, the same shape a local voice produces. What they speak is their
// own business: each lists the languages it is good for, and any other language falls back to this sandbox's voices.

export interface VoiceChunk {
    readonly samples: Float32Array;
    readonly sampleRate: number;
}

export interface CloudSpeech {
    readonly text: string;
    readonly language: string;
    // The provider's own voice id, or empty for its default in this language.
    readonly voice: string;
    // The provider's own model id, or empty for its fast default.
    readonly model: string;
    readonly speed: number;
    readonly key: string;
    readonly signal: AbortSignal;
}

export type HttpFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface CloudVoiceAdapter {
    readonly label: string;
    readonly languages: readonly string[];
    readonly speak: (speech: CloudSpeech, fetch: HttpFetch) => AsyncIterable<VoiceChunk>;
}

// A provider that answered but would not speak, in words the owner can act on.
export class CloudVoiceError extends Error {}

// The rate every provider is asked for: what Kokoro speaks at, and the highest every provider here offers without a
// plan upgrade.
const RATE = 24_000;

// Raw little-endian 16-bit mono as it arrives: a network chunk can split a sample, so the odd byte waits for the next.
export async function* pcmChunks(body: AsyncIterable<Uint8Array>, sampleRate: number): AsyncGenerator<VoiceChunk> {
    let carry: Uint8Array | undefined;
    for await (const piece of body) {
        const bytes = carry === undefined ? piece : concat(carry, piece);
        const whole = bytes.byteLength - (bytes.byteLength % 2);
        carry = whole < bytes.byteLength ? bytes.slice(whole) : undefined;
        if (whole === 0) {
            continue;
        }
        const view = new DataView(bytes.buffer, bytes.byteOffset, whole);
        const samples = new Float32Array(whole / 2);
        for (let index = 0; index < samples.length; index += 1) {
            samples[index] = view.getInt16(index * 2, true) / 32_768;
        }
        yield { samples, sampleRate };
    }
}

const concat = (first: Uint8Array, second: Uint8Array): Uint8Array => {
    const joined = new Uint8Array(first.byteLength + second.byteLength);
    joined.set(first, 0);
    joined.set(second, first.byteLength);
    return joined;
};

// A refusal in the owner's terms: a key that does not open, credits that ran out, or the provider's own words.
const refusal = async (label: string, response: Response): Promise<CloudVoiceError> => {
    // allow(silent-catch): the provider's own words are a courtesy on top of its status, which is said either way
    const said = (await response.text().catch(() => "")).replaceAll(/\s+/gu, " ").trim().slice(0, 200);
    if (response.status === 401 || response.status === 403) {
        return new CloudVoiceError(`${label} refused the API key (${response.status})${said === "" ? "" : `: ${said}`}`);
    }
    if (response.status === 429 || response.status === 402) {
        return new CloudVoiceError(`${label} is out of credits or rate-limited (${response.status})${said === "" ? "" : `: ${said}`}`);
    }
    return new CloudVoiceError(`${label} answered ${response.status}${said === "" ? "" : `: ${said}`}`);
};

// A response body's chunks through its reader, which every runtime's ReadableStream has.
async function* chunksOf(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
    const reader = stream.getReader();
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                return;
            }
            yield value;
        }
    } finally {
        reader.releaseLock();
    }
}

const streamed = async function* (label: string, response: Response): AsyncGenerator<VoiceChunk> {
    if (!response.ok || response.body === null) {
        throw await refusal(label, response);
    }
    yield* pcmChunks(chunksOf(response.body), RATE);
};

// ElevenLabs: Flash v2.5 by default, its low-latency model, which takes the language as a hint for its normaliser.
// Voice settings carry the speed. https://elevenlabs.io/docs/api-reference/text-to-speech/stream
const ELEVENLABS: CloudVoiceAdapter = {
    label: "ElevenLabs",
    // Flash v2.5's 32.
    languages: [
        "en", "ja", "zh", "de", "hi", "fr", "ko", "pt", "it", "es", "id", "nl", "tr", "fil", "pl", "sv", "bg", "ro", "ar", "cs", "el", "fi", "hr", "ms",
        "sk", "da", "ta", "uk", "ru", "hu", "no", "vi",
    ],
    async *speak ({ text, language, voice, model, speed, key, signal }, fetch) {
        // George, the voice ElevenLabs' own examples speak with; any voice of the account's library is its id.
        const id = voice === "" ? "JBFqnCBsd6RMkjVDRZzb" : voice;
        const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(id)}/stream?output_format=pcm_${RATE}`, {
            method: "POST",
            headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/pcm" },
            body: JSON.stringify({
                text,
                model_id: model === "" ? "eleven_flash_v2_5" : model,
                language_code: language,
                voice_settings: { speed: Math.min(1.2, Math.max(0.7, speed)) },
            }),
            signal,
        });
        yield* streamed("ElevenLabs", response);
    },
};

// Cartesia: Sonic 3 over the bytes endpoint, raw PCM. The version header is the date this was written against.
// https://docs.cartesia.ai/api-reference/tts/bytes
const CARTESIA: CloudVoiceAdapter = {
    label: "Cartesia",
    // Sonic 3's 42.
    languages: [
        "en", "fr", "de", "es", "pt", "zh", "ja", "hi", "it", "ko", "nl", "pl", "ru", "sv", "tr", "tl", "bg", "ro", "ar", "cs", "el", "fi", "hr", "ms",
        "sk", "da", "ta", "uk", "hu", "no", "vi", "bn", "th", "he", "ka", "id", "te", "gu", "kn", "ml", "mr", "pa",
    ],
    async *speak ({ text, language, voice, model, speed, key, signal }, fetch) {
        // The voice Cartesia's own examples speak with.
        const id = voice === "" ? "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4" : voice;
        const response = await fetch("https://api.cartesia.ai/tts/bytes", {
            method: "POST",
            headers: { authorization: `Bearer ${key}`, "cartesia-version": "2026-03-01", "content-type": "application/json" },
            body: JSON.stringify({
                model_id: model === "" ? "sonic-3" : model,
                transcript: text,
                voice: id,
                language,
                output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: RATE },
                generation_config: { speed: Math.min(1.5, Math.max(0.6, speed)) },
            }),
            signal,
        });
        yield* streamed("Cartesia", response);
    },
};

// Deepgram Aura 2: a voice is a model, one per language, so the default follows the language and a chosen voice is used
// only for its own. https://developers.deepgram.com/reference/text-to-speech/speak-request
const DEEPGRAM_DEFAULTS = new Map(
    Object.entries({
    en: "aura-2-thalia-en",
    es: "aura-2-celeste-es",
    de: "aura-2-viktoria-de",
    nl: "aura-2-rhea-nl",
    fr: "aura-2-agathe-fr",
    it: "aura-2-livia-it",
    ja: "aura-2-izanami-ja",
    }),
);

const DEEPGRAM: CloudVoiceAdapter = {
    label: "Deepgram",
    languages: [...DEEPGRAM_DEFAULTS.keys()],
    async *speak ({ text, language, voice, key, signal }, fetch) {
        const id = voice.endsWith(`-${language}`) ? voice : (DEEPGRAM_DEFAULTS.get(language) ?? "aura-2-thalia-en");
        const query = new URLSearchParams({ model: id, encoding: "linear16", sample_rate: String(RATE), container: "none" });
        const response = await fetch(`https://api.deepgram.com/v1/speak?${query}`, {
            method: "POST",
            headers: { authorization: `Token ${key}`, "content-type": "application/json" },
            body: JSON.stringify({ text }),
            signal,
        });
        yield* streamed("Deepgram", response);
    },
};

export const CLOUD_VOICES = {
    elevenlabs: ELEVENLABS,
    cartesia: CARTESIA,
    deepgram: DEEPGRAM,
} satisfies Record<CloudVoiceProvider, CloudVoiceAdapter>;

// How much text one request carries: every provider here takes several thousand characters, and a reply read whole is
// split well below that so the first audio is not waiting on the whole of it.
export const CLOUD_CHUNK_CHARS = 1_200;
