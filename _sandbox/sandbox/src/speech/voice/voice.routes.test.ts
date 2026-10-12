import type { VoiceChunk } from "./cloud-voices.js";
import { createVoiceRoute } from "./voice.routes.js";
import { type SpeakRequest, type Voice, VoiceUnprovisionedError } from "./voice.js";

/* The voice's HTTP door over a fake voice: what it hands the voice, and the audio it streams back. */

const chunk = (values: readonly number[], sampleRate = 24_000): VoiceChunk => ({ samples: new Float32Array(values), sampleRate });

const voiceWith = (speak: (request: SpeakRequest) => AsyncGenerator<VoiceChunk>): Voice => ({
    voices: async () => ({ voices: [], defaults: {}, provisioned: true }),
    speak: (request) => speak(request),
    close: () => {},
});

const appWith = (voice: Voice) => createVoiceRoute({ voice });

test("POST /speech/say streams the speech as mono s16le at the rate its header names", async () => {
    let asked: SpeakRequest | undefined;
    const app = appWith(
        voiceWith(async function* (request) {
            asked = request;
            yield chunk([0.5, -0.5]);
            yield chunk([1]);
        }),
    );
    const response = await app.request("/speech/say?as=reply&lang=pl-PL", { method: "POST", body: "Cześć, gotowe." });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-sample-rate")).toBe("24000");
    const bytes = new DataView(await response.arrayBuffer());
    expect([0, 1, 2].map((index) => bytes.getInt16(index * 2, true))).toEqual([16_384, -16_383, 32_767]);
    expect(asked).toMatchObject({ text: "Cześć, gotowe.", as: "reply", lang: "pl-PL" });
});

test("a later chunk at another rate is brought to the stream's first", async () => {
    const app = appWith(
        voiceWith(async function* () {
            yield chunk([0, 0], 24_000);
            yield chunk(Array.from({ length: 2_205 }, () => 0.25), 22_050);
        }),
    );
    const response = await app.request("/speech/say", { method: "POST", body: "Two voices." });
    expect((await response.arrayBuffer()).byteLength).toBe((2 + 2_400) * 2);
});

test("nothing to say is a 204, no text or an unknown way of saying it a 400", async () => {
    const app = appWith(
        voiceWith(async function* () {
            // says nothing
        }),
    );
    expect((await app.request("/speech/say", { method: "POST", body: "…" })).status).toBe(204);
    expect((await app.request("/speech/say", { method: "POST", body: "   " })).status).toBe(400);
    expect((await app.request("/speech/say?as=sing", { method: "POST", body: "hi" })).status).toBe(400);
    expect((await app.request("/speech/say?voice=nobody", { method: "POST", body: "hi" })).status).toBe(400);
});

test("a machine with no speech runtime answers 501", async () => {
    const app = appWith(
        voiceWith(async function* () {
            yield* [];
            throw new VoiceUnprovisionedError();
        }),
    );
    expect((await app.request("/speech/say", { method: "POST", body: "hi" })).status).toBe(501);
});

test("GET /speech/voices answers the voice's own list", async () => {
    const response = await appWith(voiceWith(async function* () {})).request("/speech/voices");
    expect(await response.json()).toEqual({ voices: [], defaults: {}, provisioned: true });
});
