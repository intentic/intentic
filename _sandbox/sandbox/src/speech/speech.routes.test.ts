import { createLogger } from "../logger.js";
import { createPerfTracker } from "../system/resources/perf.js";
import { testConfig } from "../env.config.testing.js";
import { Hono } from "hono";
import type { AppEnv } from "../app-env.js";
import { serveRawRoutes } from "../http/raw-route-server.js";
import { createSpeechRoute, createWakeClaims, type SpeechRoutesDeps, WAKE_CLAIM_MS } from "./speech.routes.js";
import { MAX_UTTERANCE_WAV_BYTES, type Speech, SpeechModelNotReadyError, SpeechUnprovisionedError } from "@intentic/speech/transcribe";
import { WavFormatError } from "@intentic/speech/wav";

/* The speech routes over their two seams (perf, speech). */

const speechApp = (...args: Parameters<typeof createSpeechRoute>): Hono<AppEnv> => serveRawRoutes(new Hono<AppEnv>(), createSpeechRoute(...args));

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
    const app = speechApp(
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
    const app = speechApp(
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
    const app = speechApp(
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
    const app = speechApp(speechDeps({}));
    // Declared: the header alone refuses before the body is read.
    const declared = await app.request("/speech/transcribe", {
        method: "POST",
        body: Buffer.from("tiny"),
        headers: { "content-length": String(MAX_UTTERANCE_WAV_BYTES + 1) },
    });
    expect(declared.status).toBe(413);
    // Discovered: an undeclared body over the cap is refused once the count passes it.
    const discovered = await app.request("/speech/transcribe", { method: "POST", body: Buffer.alloc(MAX_UTTERANCE_WAV_BYTES + 1) });
    expect(discovered.status).toBe(413);
});

// The undeclared case read the whole body before measuring it; a stream that never ends shows the read is counted.
test("an oversized chunked utterance is refused without reading it whole", async () => {
    const app = speechApp(speechDeps({}));
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
        pull(controller) {
            pulled += 65_536;
            controller.enqueue(new Uint8Array(65_536));
        },
    });
    // SAFETY: `duplex` is required by the runtime for a stream body but missing from the DOM RequestInit type.
    const response = await app.request("/speech/transcribe", { method: "POST", body, duplex: "half" } as RequestInit);
    expect(response.status).toBe(413);
    expect(pulled).toBeLessThan(MAX_UTTERANCE_WAV_BYTES + 4 * 65_536);
});

test("an empty body is a 400, not a model run over nothing", async () => {
    const app = speechApp(speechDeps({}));
    const response = await app.request("/speech/transcribe", { method: "POST" });
    expect(response.status).toBe(400);
});

test("the two refusals with a story get their own statuses: 501 rebuild, 409 wait", async () => {
    const unprovisioned = speechApp(
        speechDeps({
            transcribe: async () => {
                throw new SpeechUnprovisionedError();
            },
        }),
    );
    expect((await unprovisioned.request("/speech/transcribe", { method: "POST", body: Buffer.from("RIFF") })).status).toBe(501);
    const downloading = speechApp(
        speechDeps({
            transcribe: async () => {
                throw new SpeechModelNotReadyError();
            },
        }),
    );
    expect((await downloading.request("/speech/transcribe", { method: "POST", body: Buffer.from("RIFF") })).status).toBe(409);
});

test("audio that is not a 16-bit PCM WAV is the caller's mistake, a 400", async () => {
    const app = speechApp(
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

/* The wake claim: two devices hearing one "Leon" open one session between them. */

const claimOf = (app: Hono<AppEnv>, device: string) =>
    app.request("/speech/wake", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device }) });

test("the first device to claim a wake acts on it, and another device of the same person stands down for a few seconds", async () => {
    let now = 1_000_000;
    const app = speechApp(
        speechDeps({}),
        createWakeClaims(() => now),
    );
    expect(await (await claimOf(app, "laptop-aaaa")).json()).toEqual({ granted: true });
    now += 800;
    expect(await (await claimOf(app, "desktop-bbbb")).json()).toEqual({ granted: false });
    // Its own next wake is never refused by its last one.
    expect(await (await claimOf(app, "laptop-aaaa")).json()).toEqual({ granted: true });
    now += WAKE_CLAIM_MS;
    expect(await (await claimOf(app, "desktop-bbbb")).json()).toEqual({ granted: true });
});

test("a device in the middle of an exchange holds the person's other devices off for as long as it asked", () => {
    let now = 0;
    const claims = createWakeClaims(() => now);
    expect(claims.claim("ada@example.com", "laptop-aaaa", 60_000)).toBe(true);
    now += 45_000;
    expect(claims.claim("ada@example.com", "desktop-bbbb")).toBe(false);
    now += 20_000;
    expect(claims.claim("ada@example.com", "desktop-bbbb")).toBe(true);
});

test("two people never stand each other down", () => {
    const claims = createWakeClaims(() => 5);
    expect(claims.claim("ada@example.com", "laptop-aaaa")).toBe(true);
    expect(claims.claim("grace@example.com", "desktop-bbbb")).toBe(true);
    expect(claims.claim("ada@example.com", "phone-cccc")).toBe(false);
});

test("a claim that names no usable device is a 400", async () => {
    const app = speechApp(speechDeps({}));
    expect((await claimOf(app, "x")).status).toBe(400);
    expect((await app.request("/speech/wake", { method: "POST", body: "not json" })).status).toBe(400);
});
