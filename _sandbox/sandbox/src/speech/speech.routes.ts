import { upgradeWebSocket } from "@hono/node-server";
import { errorMessage } from "@intentic/base/errors";
import { binaryFrame } from "@intentic/base/ws-tcp-pump";
import { MAX_SPEECH_SAMPLES, SpeechClientMessageSchema, type SpeechServerMessage } from "@intentic/sandbox-contract";
import { Hono } from "hono";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import { redeemTicket } from "../auth/tokens/ws-tickets.js";
import { rawRouteServer } from "../http/raw-route-server.js";
import { MAX_UTTERANCE_WAV_BYTES, type Speech, SpeechModelNotReadyError, SpeechUnprovisionedError } from "./transcribe.js";
import { pcm16Samples, WavFormatError, wavSamples } from "./wav.js";

// Audio in, words out, off oRPC since audio doesn't fit its JSON contract.
// - `GET /speech/status?lang=` says where the locale's model stands; asking while it is absent starts fetching it.
// - `POST /speech/prepare?lang=` fetches and loads it in the background, so the first phrase does not wait on a load.
// - `POST /speech/transcribe?lang=` takes one WAV utterance (16 kHz mono s16le) and answers its text, empty for
//   silence; 501 means no runtime for this machine, 409 that the model is still on its way, unless `wait=1` asked to
//   wait it out. Discord's calls and an older composer use it.
// - `GET /speech/stream?lang=` is the composer's live wire (schemas/speech.ts): phrases stream in as they are spoken,
//   running guesses and finals stream back, and the model's readiness with them.

export type SpeechRoutesDeps = Pick<Services, "perf" | "speech">;

export const createSpeechRoute = (services: SpeechRoutesDeps): Hono<AppEnv> => {
    const app = new Hono<AppEnv>();
    const serve = rawRouteServer(app);

    serve("GET /speech/status", async (c) => c.json(await services.speech.status(c.req.query("lang"))));
    serve("POST /speech/prepare", async (c) => c.json(await services.speech.prepare(c.req.query("lang"))));

    serve("POST /speech/transcribe", async (c) => {
        const declared = Number(c.req.header("content-length"));
        if (Number.isFinite(declared) && declared > MAX_UTTERANCE_WAV_BYTES) {
            return c.json({ error: "utterance too long" }, 413);
        }
        const wav = Buffer.from(await c.req.arrayBuffer());
        if (wav.byteLength > MAX_UTTERANCE_WAV_BYTES) {
            return c.json({ error: "utterance too long" }, 413);
        }
        if (wav.byteLength === 0) {
            return c.json({ error: "empty audio" }, 400);
        }
        try {
            const locale = c.req.query("lang");
            // `wait=1` is a caller with no person to show a progress bar to (Discord's calls): it would rather wait out
            // a first fetch of the model than be told to come back.
            const text = await services.perf.track("speech.transcribe", { bytes: wav.byteLength }, () =>
                c.req.query("wait") === "1" ? services.speech.hear(wavSamples(wav), locale) : services.speech.transcribe(wav, locale),
            );
            return c.json({ text });
        } catch (error) {
            if (error instanceof SpeechUnprovisionedError) {
                return c.json({ error: error.message }, 501);
            }
            if (error instanceof SpeechModelNotReadyError) {
                return c.json({ error: error.message }, 409);
            }
            if (error instanceof WavFormatError) {
                return c.json({ error: error.message }, 400);
            }
            throw error;
        }
    });

    return app;
};

// A running guess is made at most this often, and never sooner than twice the last one took: a phrase heard in 100 ms
// updates five times a second, and a box under load backs off on its own.
const GUESS_EVERY_MS = 400;
// The guess loop's tick; cheap, since a tick with nothing new to hear does nothing.
const TICK_MS = 100;
// Less than this much speech is too little to guess at: on half a second Parakeet cannot yet tell which language it is
// hearing, and a Polish phrase flashes up as English words before it settles.
const MIN_GUESS_SAMPLES = 19_200;

interface Phrase {
    readonly id: number;
    readonly chunks: Float32Array[];
    length: number;
    // How much of it the last guess heard, when it started, and whether one is out now.
    guessedLength: number;
    guessedAt: number;
    guessing: boolean;
    // The last guess sent, so a pause that changes nothing sends nothing.
    guessed: string;
}

const joined = (phrase: Phrase, keep = phrase.length): Float32Array => {
    const out = new Float32Array(Math.min(keep, phrase.length));
    let at = 0;
    for (const chunk of phrase.chunks) {
        if (at >= out.length) {
            break;
        }
        const part = chunk.subarray(0, out.length - at);
        out.set(part, at);
        at += part.length;
    }
    return out;
};

interface Socket {
    send(data: string): void;
    close(code?: number, reason?: string): void;
}

export type SpeechStreamDeps = Pick<Services, "speech" | "auth" | "wsTickets" | "logger" | "perf">;

export const createSpeechStreamRoute = (services: SpeechStreamDeps) =>
    upgradeWebSocket((c) => {
        const locale = new URL(c.req.url).searchParams.get("lang") ?? undefined;
        const speech: Speech = services.speech;
        let closed = false;
        let phrase: Phrase | undefined;
        // Finals are heard in the order their phrases ended, whatever the guesses in between do.
        let finals: Promise<void> = Promise.resolve();
        let lastGuessMs = 0;
        let ticker: ReturnType<typeof setInterval> | undefined;
        let unsubscribe: (() => void) | undefined;
        let unregisterAccess: (() => void) | undefined;

        const send = (ws: Socket, message: SpeechServerMessage): void => {
            if (!closed) {
                ws.send(JSON.stringify(message));
            }
        };

        const pushStatus = async (ws: Socket): Promise<void> => {
            const status = await speech.status(locale);
            send(ws, { type: "status", status });
        };

        // A guess at the phrase still being spoken: only when there is new speech to hear, the model is in memory and
        // idle, and the last guess is far enough behind. Each answer is the whole phrase so far, replacing the last.
        const guess = async (ws: Socket): Promise<void> => {
            const current = phrase;
            if (current === undefined || current.guessing || current.length < MIN_GUESS_SAMPLES || current.length === current.guessedLength) {
                return;
            }
            if (Date.now() - current.guessedAt < Math.max(GUESS_EVERY_MS, 2 * lastGuessMs) || !speech.guessable(locale)) {
                return;
            }
            current.guessing = true;
            current.guessedAt = Date.now();
            current.guessedLength = current.length;
            try {
                const text = await speech.hear(joined(current), locale);
                lastGuessMs = Date.now() - current.guessedAt;
                if (phrase === current && text !== "" && text !== current.guessed) {
                    current.guessed = text;
                    send(ws, { type: "partial", id: current.id, text });
                }
            } catch {
                // allow(silent-catch): a failed guess is only a missing preview; the final says what went wrong, if anything did.
            } finally {
                current.guessing = false;
            }
        };

        const end = (ws: Socket, ended: Phrase, keep: number): void => {
            const samples = joined(ended, keep);
            const receivedAt = Date.now();
            finals = finals.then(async () => {
                try {
                    const text = await services.perf.track("speech.hear", { samples: samples.length }, () => speech.hear(samples, locale));
                    send(ws, { type: "final", id: ended.id, text, decodeMs: Date.now() - receivedAt });
                } catch (error) {
                    services.logger.warn({ err: error }, "speech stream could not hear a phrase");
                    send(ws, { type: "error", id: ended.id, message: errorMessage(error) });
                }
            });
        };

        const cleanup = (): void => {
            closed = true;
            phrase = undefined;
            clearInterval(ticker);
            unsubscribe?.();
            unregisterAccess?.();
        };

        return {
            onOpen: async (_event, ws) => {
                try {
                    // Dictating is writing a message: the collaborator's grant, as on the transcribe door.
                    const caller = redeemTicket(services, new URL(c.req.url).searchParams, "collaborator");
                    if (caller !== undefined) {
                        unregisterAccess = services.auth?.connections.register(caller, () => ws.close(1008, "authorization revoked"));
                    }
                } catch (error) {
                    services.logger.warn({ err: error }, "speech stream ticket rejected");
                    ws.close(1008, "unauthorized");
                    return;
                }
                unsubscribe = speech.subscribe(() => void pushStatus(ws));
                // Opening the stream is the person reaching for the mic: fetch and load the model now, while they speak.
                send(ws, { type: "status", status: await speech.prepare(locale) });
                ticker = setInterval(() => void guess(ws), TICK_MS);
            },
            onMessage: (event, ws) => {
                if (closed) {
                    return;
                }
                const bytes = binaryFrame(event.data);
                if (bytes !== undefined) {
                    if (phrase !== undefined && phrase.length < MAX_SPEECH_SAMPLES) {
                        const samples = pcm16Samples(bytes).subarray(0, MAX_SPEECH_SAMPLES - phrase.length);
                        phrase.chunks.push(samples);
                        phrase.length += samples.length;
                    }
                    return;
                }
                let parsed: unknown;
                try {
                    parsed = JSON.parse(String(event.data));
                } catch {
                    // allow(silent-catch): a text frame that is not JSON is no message of the protocol, dropped like one the schema refuses below
                    return;
                }
                const message = SpeechClientMessageSchema.safeParse(parsed);
                if (!message.success) {
                    return;
                }
                if (message.data.type === "begin") {
                    phrase = { id: message.data.id, chunks: [], length: 0, guessedLength: 0, guessedAt: 0, guessing: false, guessed: "" };
                    return;
                }
                const current = phrase;
                if (current === undefined || current.id !== message.data.id) {
                    return;
                }
                phrase = undefined;
                if (message.data.type === "end") {
                    end(ws, current, message.data.keep);
                }
            },
            onClose: cleanup,
            onError: cleanup,
        };
    });
