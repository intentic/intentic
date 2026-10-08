import { createLogger } from "../logger.js";
import { createPerfTracker } from "../system/resources/perf.js";
import { testConfig } from "../testing.js";
import { createSpeechRoute, type SpeechRoutesDeps } from "./speech.routes.js";
import { MAX_UTTERANCE_WAV_BYTES, type Speech, SpeechModelNotReadyError, SpeechUnprovisionedError } from "./transcribe.js";
import { WavFormatError } from "./wav.js";

/* The speech routes over their two seams (perf, speech). */

const speechDeps = (speech: Partial<Speech>): SpeechRoutesDeps => ({
    perf: createPerfTracker(createLogger(testConfig)),
    speech: {
        status: async () => ({ provisioned: true, model: "ready" }),
        prepare: async () => ({ provisioned: true, model: "ready" }),
        transcribe: async () => "",
        hear: async () => "",
        guessable: () => false,
        subscribe: () => () => {},
        close: () => {},
        ...speech,
    },
});

test("GET /speech/status answers the engine's report for the asked locale verbatim", async () => {
    let asked: string | undefined;
    const app = createSpeechRoute(
        speechDeps({
            status: async (locale) => {
                asked = locale;
                return { provisioned: true, model: "downloading", engine: "whisper", received: 10, total: 100 };
            },
        }),
    );
    const response = await app.request("/speech/status?lang=ja-JP");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ provisioned: true, model: "downloading", engine: "whisper", received: 10, total: 100 });
    expect(asked).toBe("ja-JP");
});

test("POST /speech/prepare arms the locale's model and answers where it stands", async () => {
    let asked: string | undefined;
    const app = createSpeechRoute(
        speechDeps({
            prepare: async (locale) => {
                asked = locale;
                return { provisioned: true, model: "ready", engine: "parakeet", loaded: false };
            },
        }),
    );
    const response = await app.request("/speech/prepare?lang=pl", { method: "POST" });
    expect(await response.json()).toEqual({ provisioned: true, model: "ready", engine: "parakeet", loaded: false });
    expect(asked).toBe("pl");
});

test("POST /speech/transcribe hands the WAV and locale to the engine and answers its text", async () => {
    let seen: { bytes: number; locale: string | undefined } | undefined;
    const app = createSpeechRoute(
        speechDeps({
            transcribe: async (wav, locale) => {
                seen = { bytes: wav.byteLength, locale };
                return "hello from voice";
            },
        }),
    );
    const response = await app.request("/speech/transcribe?lang=pl-PL", { method: "POST", body: Buffer.from("RIFF wav bytes") });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "hello from voice" });
    expect(seen).toEqual({ bytes: 14, locale: "pl-PL" });
});

test("an oversized utterance is refused whether declared or discovered", async () => {
    const app = createSpeechRoute(speechDeps({}));
    // Declared: the header alone refuses before the body is read.
    const declared = await app.request("/speech/transcribe", {
        method: "POST",
        body: Buffer.from("tiny"),
        headers: { "content-length": String(MAX_UTTERANCE_WAV_BYTES + 1) },
    });
    expect(declared.status).toBe(413);
    // Discovered: an undeclared body over the cap is refused after buffering.
    const discovered = await app.request("/speech/transcribe", { method: "POST", body: Buffer.alloc(MAX_UTTERANCE_WAV_BYTES + 1) });
    expect(discovered.status).toBe(413);
});

test("an empty body is a 400, not a model run over nothing", async () => {
    const app = createSpeechRoute(speechDeps({}));
    const response = await app.request("/speech/transcribe", { method: "POST" });
    expect(response.status).toBe(400);
});

test("the two refusals with a story get their own statuses: 501 rebuild, 409 wait", async () => {
    const unprovisioned = createSpeechRoute(
        speechDeps({
            transcribe: async () => {
                throw new SpeechUnprovisionedError();
            },
        }),
    );
    expect((await unprovisioned.request("/speech/transcribe", { method: "POST", body: Buffer.from("RIFF") })).status).toBe(501);
    const downloading = createSpeechRoute(
        speechDeps({
            transcribe: async () => {
                throw new SpeechModelNotReadyError();
            },
        }),
    );
    expect((await downloading.request("/speech/transcribe", { method: "POST", body: Buffer.from("RIFF") })).status).toBe(409);
});

test("audio that is not a 16-bit PCM WAV is the caller's mistake, a 400", async () => {
    const app = createSpeechRoute(
        speechDeps({
            transcribe: async () => {
                throw new WavFormatError("not a WAV file");
            },
        }),
    );
    const response = await app.request("/speech/transcribe", { method: "POST", body: Buffer.from("OggS") });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "not a WAV file" });
});
