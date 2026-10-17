import { once } from "node:events";
import { createAdaptorServer, type WebSocketServerLike } from "@hono/node-server";
import { unstubbed } from "@intentic/testing";
import { waitFor } from "@intentic/testing/bun";
import { opusPackets, type VoiceServerMessage, VoiceServerMessageSchema } from "@intentic/sandbox-contract/schemas/voice";
import { opusDecoder } from "@intentic/speech/opus";
import { Hono } from "hono";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import type { Services } from "../../composition.js";
import { createLogger } from "../../logger.js";
import { testConfig } from "../../env.config.testing.js";
import type { VoiceChunk } from "@intentic/speech/voice/cloud-voices";
import { createVoiceStreamRoute } from "./voice.routes.js";
import type { SpeakEvents, SpeakRequest, Voice } from "@intentic/speech/voice/voice";

/* The editor's player wire over a real socket, with the voice faked: each utterance's words and audio come back in
   order, a header before each binary frame, then `done`; a stop ends one mid-way and the next is still said. */

// A voice that says each sentence as a chunk of as many samples as it has characters, slowly enough to be stopped.
interface FakeVoice {
    readonly voice: Voice;
    readonly asked: SpeakRequest[];
}

const fakeVoice = (): FakeVoice => {
    const asked: SpeakRequest[] = [];
    const voice: Voice = {
        voices: async () => ({ voices: [], defaults: {}, provisioned: true }),
        async *speak (request: SpeakRequest, signal: AbortSignal, events?: SpeakEvents): AsyncGenerator<VoiceChunk> {
            asked.push(request);
            events?.spoken?.({ text: request.text, lang: "en", voice: "kokoro/af_heart" });
            for (const sentence of request.text.split(". ")) {
                if (signal.aborted) {
                    return;
                }
                await new Promise((resolve) => setTimeout(resolve, 20));
                yield { samples: new Float32Array(sentence.length).fill(0.5), sampleRate: 24_000 };
            }
        },
        close: () => {},
    };
    return { voice, asked };
};

// ws hands a binary frame over as one Buffer, a list of them, or an ArrayBuffer, by its `binaryType`.
const byteLengthOf = (data: Buffer | ArrayBuffer | Buffer[]): number =>
    Array.isArray(data) ? data.reduce((total, part) => total + part.byteLength, 0) : data.byteLength;

type Heard = VoiceServerMessage | { readonly type: "bytes"; readonly length: number };

const stand = async (voice: Voice, query = "") => {
    // No auth: the loopback daemon, which takes no ticket.
    const services = unstubbed<Parameters<typeof createVoiceStreamRoute>[0]>("services", {
        voice,
        auth: undefined,
        wsTickets: unstubbed<Services["wsTickets"]>("wsTickets", {}),
        logger: createLogger(testConfig),
    });
    const app = new Hono().get("/speech/say", createVoiceStreamRoute(services));
    // SAFETY: ws's own server is the one hono's adapter is written against (desktop-view.integration.test.ts says why).
    const sockets = new WebSocketServer({ noServer: true }) as WebSocketServerLike;
    const server = createAdaptorServer({ fetch: app.fetch, websocket: { server: sockets } });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = z.object({ port: z.number() }).parse(server.address());
    const heard: Heard[] = [];
    const frames: Uint8Array[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${port}/speech/say${query}`);
    socket.on("message", (data, binary) => {
        // A binary frame is the audio a header announced; its length is checked here, and its bytes kept to decode.
        heard.push(binary ? { type: "bytes", length: byteLengthOf(data) } : VoiceServerMessageSchema.parse(JSON.parse(String(data))));
        if (binary) {
            frames.push(data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(Buffer.concat(Array.isArray(data) ? data : [data])));
        }
    });
    await once(socket, "open");
    return {
        socket,
        heard,
        frames,
        close: () => {
            socket.close();
            server.close();
        },
    };
};

test("an utterance comes back as its words, a header before each frame of audio, then done", async () => {
    const fake = fakeVoice();
    const wire = await stand(fake.voice);
    try {
        wire.socket.send(JSON.stringify({ type: "say", id: 1, text: "Hello there. All done", as: "reply", asked: "Fix it", conversationId: "c-9" }));
        await waitFor(() => expect(wire.heard.at(-1)).toEqual({ type: "done", id: 1 }));
        expect(wire.heard).toEqual([
            { type: "spoken", id: 1, text: "Hello there. All done", lang: "en", voice: "kokoro/af_heart" },
            { type: "audio", id: 1, sampleRate: 24_000, samples: 11 },
            { type: "bytes", length: 22 },
            { type: "audio", id: 1, sampleRate: 24_000, samples: 8 },
            { type: "bytes", length: 16 },
            { type: "done", id: 1 },
        ]);
        expect(fake.asked[0]).toMatchObject({ as: "reply", asked: "Fix it", conversationId: "c-9" });
    } finally {
        wire.close();
    }
});

// A player that asks with `codec=opus` (the editor does where the hello names it) hears each chunk as its Opus packets,
// a twelfth of the PCM, which decode back to the chunk padded out to whole 20 ms packets.
test("a socket opened with codec=opus hears each chunk as Opus packets that decode back to it", async () => {
    const voice: Voice = {
        ...fakeVoice().voice,
        async *speak () {
            yield { samples: Float32Array.from({ length: 24_000 }, (_, index) => 0.4 * Math.sin((2 * Math.PI * 180 * index) / 24_000)), sampleRate: 24_000 };
        },
    };
    const wire = await stand(voice, "?codec=opus");
    try {
        wire.socket.send(JSON.stringify({ type: "say", id: 4, text: "Hello" }));
        await waitFor(() => expect(wire.heard.at(-1)).toEqual({ type: "done", id: 4 }));
        expect(wire.heard[0]).toEqual({ type: "audio", id: 4, sampleRate: 24_000, samples: 24_000, codec: "opus" });
        const frame = wire.frames[0] ?? new Uint8Array();
        expect(frame.byteLength).toBeLessThan((24_000 * 2) / 8);
        const decode = opusDecoder(24_000);
        expect(opusPackets(frame).reduce((total, packet) => total + decode(packet).length, 0)).toBe(24_000);
    } finally {
        wire.close();
    }
});

test("a stop ends its utterance without a done, and the next is still said", async () => {
    const wire = await stand(fakeVoice().voice);
    try {
        wire.socket.send(JSON.stringify({ type: "say", id: 1, text: "One. Two. Three. Four. Five. Six" }));
        await waitFor(() => expect(wire.heard.some((message) => message.type === "audio")).toBe(true));
        wire.socket.send(JSON.stringify({ type: "stop", id: 1 }));
        wire.socket.send(JSON.stringify({ type: "say", id: 2, text: "Next" }));
        await waitFor(() => expect(wire.heard.at(-1)).toEqual({ type: "done", id: 2 }));
        const first = wire.heard.filter((message) => "id" in message && message.id === 1);
        expect(first.some((message) => message.type === "done")).toBe(false);
        expect(first.filter((message) => message.type === "audio").length).toBeLessThan(6);
    } finally {
        wire.close();
    }
});

test("a message the protocol does not know is answered with an error, and the socket stays up", async () => {
    const wire = await stand(fakeVoice().voice);
    try {
        wire.socket.send(JSON.stringify({ type: "sing", id: 1 }));
        await waitFor(() => expect(wire.heard[0]?.type).toBe("error"));
        wire.socket.send(JSON.stringify({ type: "say", id: 2, text: "Still here" }));
        await waitFor(() => expect(wire.heard.at(-1)).toEqual({ type: "done", id: 2 }));
    } finally {
        wire.close();
    }
});
