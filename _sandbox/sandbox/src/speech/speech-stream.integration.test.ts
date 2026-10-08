import { once } from "node:events";
import { createAdaptorServer, type WebSocketServerLike } from "@hono/node-server";
import { unstubbed } from "@intentic/testing";
import { waitFor } from "@intentic/testing/bun";
import { type SpeechServerMessage, SpeechServerMessageSchema, type SpeechStatus } from "@intentic/sandbox-contract";
import { Hono } from "hono";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import type { Services } from "../composition.js";
import { createLogger } from "../logger.js";
import { createPerfTracker } from "../system/resources/perf.js";
import { testConfig } from "../testing.js";
import { createSpeechStreamRoute } from "./speech.routes.js";
import type { Speech } from "./transcribe.js";

/* The composer's live dictation wire over a real socket, with the models faked: a phrase streams in as s16le frames
   between `begin` and `end`, running guesses come back while it is spoken, one final per ended phrase comes back in
   order, trimmed to what the composer kept, and the model's readiness is pushed as it moves. */

const READY: SpeechStatus = { provisioned: true, model: "ready", engine: "parakeet", loaded: true };

interface Heard {
    readonly samples: number;
    readonly locale: string | undefined;
}

// A model that hears a phrase as how many samples it had, so a test can read what reached it off the text.
const fakeSpeech = (options: { readonly guessable?: boolean; readonly delayMs?: (samples: number) => number } = {}) => {
    const heard: Heard[] = [];
    const listeners = new Set<() => void>();
    let status = READY;
    const speech: Speech = {
        status: async () => status,
        prepare: async () => status,
        transcribe: async () => "",
        hear: async (samples, locale) => {
            heard.push({ samples: samples.length, locale });
            await new Promise((resolve) => setTimeout(resolve, options.delayMs?.(samples.length) ?? 0));
            return `heard ${samples.length}`;
        },
        guessable: () => options.guessable ?? false,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        close: () => {},
    };
    const move = (next: SpeechStatus): void => {
        status = next;
        for (const listener of listeners) {
            listener();
        }
    };
    return { speech, heard, move };
};

const stand = async (speech: Speech) => {
    // No auth: the loopback daemon, which takes no ticket.
    const services = unstubbed<Parameters<typeof createSpeechStreamRoute>[0]>("services", {
        speech,
        auth: undefined,
        wsTickets: unstubbed<Services["wsTickets"]>("wsTickets", {}),
        logger: createLogger(testConfig),
        perf: createPerfTracker(createLogger(testConfig)),
    });
    const app = new Hono().get("/speech/stream", createSpeechStreamRoute(services));
    // SAFETY: ws's own server is the one hono's adapter is written against (desktop-view.integration.test.ts says why).
    const sockets = new WebSocketServer({ noServer: true }) as WebSocketServerLike;
    const server = createAdaptorServer({ fetch: app.fetch, websocket: { server: sockets } });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = z.object({ port: z.number() }).parse(server.address());
    const said: SpeechServerMessage[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${port}/speech/stream?lang=pl-PL`);
    socket.on("message", (data) => said.push(SpeechServerMessageSchema.parse(JSON.parse(String(data)))));
    await once(socket, "open");
    return {
        socket,
        said,
        close: () => {
            socket.close();
            server.close();
        },
    };
};

// `samples` of 16 kHz s16le audio, one frame.
const frame = (samples: number): Buffer => Buffer.alloc(samples * 2, 1);

const finals = (said: SpeechServerMessage[]) => said.flatMap((message) => (message.type === "final" ? [message] : []));

test("each ended phrase comes back once, in order, heard as far as the composer kept it, in the socket's language", async () => {
    const fake = fakeSpeech({ delayMs: (samples) => (samples > 10_000 ? 50 : 0) });
    const wire = await stand(fake.speech);
    try {
        await waitFor(() => expect(wire.said[0]).toEqual({ type: "status", status: READY }));
        wire.socket.send(JSON.stringify({ type: "begin", id: 1 }));
        wire.socket.send(frame(8_000));
        wire.socket.send(frame(8_000));
        wire.socket.send(JSON.stringify({ type: "end", id: 1, keep: 12_000 }));
        // The second is quicker to hear than the first; it still comes back second.
        wire.socket.send(JSON.stringify({ type: "begin", id: 2 }));
        wire.socket.send(frame(4_000));
        wire.socket.send(JSON.stringify({ type: "end", id: 2, keep: 4_000 }));
        // A dropped phrase is never heard.
        wire.socket.send(JSON.stringify({ type: "begin", id: 3 }));
        wire.socket.send(frame(4_000));
        wire.socket.send(JSON.stringify({ type: "drop", id: 3 }));
        await waitFor(() => expect(finals(wire.said)).toHaveLength(2));
        expect(finals(wire.said).map(({ id, text }) => ({ id, text }))).toEqual([
            { id: 1, text: "heard 12000" },
            { id: 2, text: "heard 4000" },
        ]);
        expect(finals(wire.said).every((message) => message.decodeMs >= 0)).toBe(true);
        expect(fake.heard.every(({ locale }) => locale === "pl-PL")).toBe(true);
    } finally {
        wire.close();
    }
});

test("a phrase still being spoken is guessed at when the model can spare it, never when it cannot", async () => {
    const quiet = fakeSpeech({ guessable: false });
    const busy = await stand(quiet.speech);
    try {
        busy.socket.send(JSON.stringify({ type: "begin", id: 1 }));
        busy.socket.send(frame(32_000));
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect(busy.said.filter((message) => message.type === "partial")).toEqual([]);
        expect(quiet.heard).toEqual([]);
    } finally {
        busy.close();
    }

    const fake = fakeSpeech({ guessable: true });
    const wire = await stand(fake.speech);
    try {
        wire.socket.send(JSON.stringify({ type: "begin", id: 7 }));
        // Under 1.2 s is too little to guess at.
        wire.socket.send(frame(16_000));
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect(wire.said.filter((message) => message.type === "partial")).toEqual([]);
        wire.socket.send(frame(8_000));
        await waitFor(() => expect(wire.said).toContainEqual({ type: "partial", id: 7, text: "heard 24000" }));
        // New speech is a new guess at the whole phrase so far.
        wire.socket.send(frame(8_000));
        await waitFor(() => expect(wire.said).toContainEqual({ type: "partial", id: 7, text: "heard 32000" }));
        wire.socket.send(JSON.stringify({ type: "end", id: 7, keep: 32_000 }));
        await waitFor(() => expect(finals(wire.said)).toEqual([expect.objectContaining({ id: 7, text: "heard 32000" })]));
    } finally {
        wire.close();
    }
});

test("the model's readiness is pushed as it moves, so the composer can show a fetch's progress", async () => {
    const fake = fakeSpeech();
    const wire = await stand(fake.speech);
    try {
        await waitFor(() => expect(wire.said).toHaveLength(1));
        const downloading: SpeechStatus = { provisioned: true, model: "downloading", engine: "parakeet", received: 5, total: 10 };
        fake.move(downloading);
        await waitFor(() => expect(wire.said.at(-1)).toEqual({ type: "status", status: downloading }));
    } finally {
        wire.close();
    }
});
