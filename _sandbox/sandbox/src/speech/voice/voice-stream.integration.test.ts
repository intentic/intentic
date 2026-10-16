import { once } from "node:events";
import { createAdaptorServer, type WebSocketServerLike } from "@hono/node-server";
import { unstubbed } from "@intentic/testing";
import { waitFor } from "@intentic/testing/bun";
import { type VoiceServerMessage, VoiceServerMessageSchema } from "@intentic/sandbox-contract/schemas/voice";
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

const stand = async (voice: Voice) => {
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
    const socket = new WebSocket(`ws://127.0.0.1:${port}/speech/say`);
    socket.on("message", (data, binary) => {
        // A binary frame is the audio a header announced; only its length is checked here.
        heard.push(binary ? { type: "bytes", length: byteLengthOf(data) } : VoiceServerMessageSchema.parse(JSON.parse(String(data))));
    });
    await once(socket, "open");
    return {
        socket,
        heard,
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
