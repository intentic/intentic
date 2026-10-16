import { CLOUD_VOICES, CloudVoiceError, type HttpFetch, pcmChunks, type VoiceChunk } from "./cloud-voices.js";

/* The providers over a fake fetch: what each is asked, how its raw audio is read, and how a refusal is said. */

async function* pieces(...chunks: number[][]): AsyncGenerator<Uint8Array> {
    for (const chunk of chunks) {
        yield new Uint8Array(chunk);
    }
}

const collect = async (chunks: AsyncIterable<VoiceChunk>): Promise<number[]> => {
    const samples: number[] = [];
    for await (const chunk of chunks) {
        samples.push(...chunk.samples);
    }
    return samples;
};

test("raw s16le is read across chunk boundaries that split a sample", async () => {
    // 0x4000 (0.5) split over two chunks, then -0x8000 (-1).
    const samples = await collect(pcmChunks(pieces([0x00], [0x40, 0x00], [0x80]), 24_000));
    expect(samples).toEqual([0.5, -1]);
});

// What speaking failed with: the error, or nothing when it did not fail.
const failureOf = async (chunks: AsyncIterable<VoiceChunk>): Promise<Error | undefined> => {
    try {
        await collect(chunks);
        return undefined;
    } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
    }
};

interface Asked {
    readonly url: string;
    readonly init: RequestInit;
}

interface Answering {
    readonly fetch: HttpFetch;
    readonly asked: Asked[];
}

const answering = (response: () => Response): Answering => {
    const asked: Asked[] = [];
    return {
        asked,
        fetch: async (url, init) => {
            asked.push({ url, init });
            return response();
        },
    };
};

const pcmResponse = (): Response => new Response(new Uint8Array([0x00, 0x40, 0x00, 0xc0]), { status: 200 });

const speech = { text: "Cześć.", language: "pl", voice: "", model: "", speed: 1, key: "k-123", signal: new AbortController().signal };

test("ElevenLabs is asked for raw PCM with its fast model, the language and the key in its own header", async () => {
    const { fetch, asked } = answering(pcmResponse);
    expect(await collect(CLOUD_VOICES.elevenlabs.speak(speech, fetch))).toEqual([0.5, -0.5]);
    expect(asked[0]!.url).toContain("/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/stream?output_format=pcm_24000");
    expect(new Headers(asked[0]!.init.headers).get("xi-api-key")).toBe("k-123");
    expect(JSON.parse(String(asked[0]!.init.body))).toMatchObject({ text: "Cześć.", model_id: "eleven_flash_v2_5", language_code: "pl" });
});

test("Cartesia is asked for raw pcm_s16le, versioned, with a bearer key", async () => {
    const { fetch, asked } = answering(pcmResponse);
    await collect(CLOUD_VOICES.cartesia.speak({ ...speech, voice: "v-1", model: "sonic-x" }, fetch));
    const headers = new Headers(asked[0]!.init.headers);
    expect(headers.get("authorization")).toBe("Bearer k-123");
    expect(headers.get("cartesia-version")).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(JSON.parse(String(asked[0]!.init.body))).toMatchObject({
        model_id: "sonic-x",
        transcript: "Cześć.",
        voice: "v-1",
        language: "pl",
        output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: 24_000 },
    });
});

test("Deepgram's voice follows the language, since each of its voices speaks one", async () => {
    const { fetch, asked } = answering(pcmResponse);
    await collect(CLOUD_VOICES.deepgram.speak({ ...speech, language: "de", voice: "aura-2-thalia-en" }, fetch));
    expect(asked[0]!.url).toContain("model=aura-2-viktoria-de");
    expect(asked[0]!.url).toContain("encoding=linear16");
    expect(new Headers(asked[0]!.init.headers).get("authorization")).toBe("Token k-123");
});

test("a refused key is said as one, with the provider's own words", async () => {
    const { fetch } = answering(() => new Response("invalid api key", { status: 401 }));
    const failure = await failureOf(CLOUD_VOICES.elevenlabs.speak(speech, fetch));
    expect(failure).toBeInstanceOf(CloudVoiceError);
    expect(failure?.message).toBe("ElevenLabs refused the API key (401): invalid api key");
});

test("spent credits are said as such", async () => {
    const { fetch } = answering(() => new Response("", { status: 429 }));
    const failure = await failureOf(CLOUD_VOICES.cartesia.speak(speech, fetch));
    expect(failure?.message).toBe("Cartesia is out of credits or rate-limited (429)");
});
