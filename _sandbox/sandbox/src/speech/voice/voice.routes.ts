import { upgradeWebSocket } from "@hono/node-server";
import { errorMessage } from "@intentic/base/errors";
import { binaryFrame } from "@intentic/base/ws-tcp-pump";
import {
    MAX_SPOKEN_TEXT,
    SpeakAsSchema,
    VoiceClientMessageSchema,
    VoiceIdSchema,
    type VoiceClientMessage,
    type VoiceServerMessage,
} from "@intentic/sandbox-contract";
import { Hono } from "hono";
import type { WSContext } from "hono/ws";
import type { AppEnv } from "../../app-env.js";
import { redeemTicket } from "../../auth/tokens/ws-tickets.js";
import type { Services } from "../../composition.js";
import { readBoundedBytes } from "../../http/bounded-body.js";
import { rawRouteServer } from "../../http/raw-route-server.js";
import { opt } from "../../opt.js";
import type { VoiceChunk } from "./cloud-voices.js";
import { paced, pcm16, resampled } from "./voice-audio.js";
import { type SpeakRequest, VoiceUnprovisionedError } from "./voice.js";

// Text in, speech out, off oRPC since audio doesn't fit its JSON contract (schemas/voice.ts).
// - `GET /speech/voices` lists the voices to choose from, and what speaks a language nobody chose for.
// - `POST /speech/say?as=&lang=&voice=` takes the text as its body and streams the speech back as raw mono s16le at the
//   rate `x-sample-rate` names (one rate for the whole answer); 501 means no runtime for this machine. Discord's calls.
// - `GET /speech/say` is the editor's player: a socket of utterances, each streamed back as it is made.

export type VoiceRoutesDeps = Pick<Services, "voice">;

// A request's text, counted as it arrives like dictation's audio: a chunked body declares no length.
const MAX_BODY_BYTES = MAX_SPOKEN_TEXT * 4;

export const createVoiceRoute = (services: VoiceRoutesDeps): Hono<AppEnv> => {
    const app = new Hono<AppEnv>();
    const serve = rawRouteServer(app);

    serve("GET /speech/voices", async (c) => c.json(await services.voice.voices()));

    serve("POST /speech/say", async (c) => {
        const body = await readBoundedBytes(c.req.raw, MAX_BODY_BYTES);
        if (body.kind !== "ok") {
            return c.json({ error: "text too long" }, 413);
        }
        const text = new TextDecoder().decode(body.value).trim();
        const as = SpeakAsSchema.safeParse(c.req.query("as") ?? "plain");
        const voice = c.req.query("voice") === undefined ? undefined : VoiceIdSchema.safeParse(c.req.query("voice"));
        if (text === "" || text.length > MAX_SPOKEN_TEXT || !as.success || voice?.success === false) {
            return c.json({ error: "say needs text, and `as` and `voice` as schemas/voice.ts spells them" }, 400);
        }
        const request: SpeakRequest = { text, as: as.data, lang: c.req.query("lang"), voice: voice?.data };
        // The request's own signal ends when the caller hangs up, which is how Discord stops a voice mid-sentence.
        const signal = c.req.raw.signal;
        const chunks = paced(services.voice.speak(request, signal), signal);
        let first: IteratorResult<VoiceChunk>;
        try {
            first = await chunks.next();
        } catch (error) {
            if (error instanceof VoiceUnprovisionedError) {
                return c.json({ error: error.message }, 501);
            }
            throw error;
        }
        if (first.done === true) {
            return c.body(null, 204);
        }
        const rate = first.value.sampleRate;
        const stream = new ReadableStream<Uint8Array>({
            start: (controller) => controller.enqueue(pcm16(first.value.samples)),
            pull: async (controller) => {
                try {
                    const next = await chunks.next();
                    if (next.done === true) {
                        controller.close();
                        return;
                    }
                    controller.enqueue(pcm16(resampled(next.value.samples, next.value.sampleRate, rate)));
                } catch (error) {
                    controller.error(error);
                }
            },
            cancel: async () => {
                await chunks.return(undefined);
            },
        });
        return new Response(stream, {
            headers: { "content-type": `audio/L16; rate=${rate}; channels=1`, "x-sample-rate": String(rate), "cache-control": "no-store" },
        });
    });

    return app;
};

export type VoiceStreamDeps = Pick<Services, "voice" | "auth" | "wsTickets" | "logger">;

export const createVoiceStreamRoute = (services: VoiceStreamDeps) =>
    upgradeWebSocket((c) => {
        let closed = false;
        // Utterances are said one at a time, in the order they were asked.
        let queue: Promise<void> = Promise.resolve();
        const running = new Map<number, AbortController>();
        let unregisterAccess: (() => void) | undefined;

        const send = (ws: WSContext, message: VoiceServerMessage): void => {
            if (!closed) {
                ws.send(JSON.stringify(message));
            }
        };

        const say = (ws: WSContext, message: Extract<VoiceClientMessage, { type: "say" }>): void => {
            const { id } = message;
            const controller = new AbortController();
            running.get(id)?.abort();
            running.set(id, controller);
            const { signal } = controller;
            const request: SpeakRequest = {
                text: message.text,
                as: message.as,
                ...opt("lang", message.lang),
                ...opt("voice", message.voice),
                ...opt("asked", message.asked),
                ...opt("conversationId", message.conversationId),
            };
            queue = queue.then(async () => {
                if (signal.aborted || closed) {
                    return;
                }
                try {
                    const speech = services.voice.speak(request, signal, {
                        status: (status) => send(ws, { type: "status", id, status }),
                        spoken: (words) => send(ws, { type: "spoken", id, ...words }),
                        notice: (said) => send(ws, { type: "notice", id, message: said }),
                    });
                    for await (const chunk of paced(speech, signal)) {
                        if (signal.aborted || closed) {
                            break;
                        }
                        send(ws, { type: "audio", id, sampleRate: chunk.sampleRate, samples: chunk.samples.length });
                        ws.send(pcm16(chunk.samples));
                    }
                    if (!signal.aborted) {
                        send(ws, { type: "done", id });
                    }
                } catch (error) {
                    if (!signal.aborted) {
                        services.logger.warn({ err: error }, "voice stream could not speak an utterance");
                        send(ws, { type: "error", id, message: errorMessage(error) });
                    }
                } finally {
                    if (running.get(id) === controller) {
                        running.delete(id);
                    }
                }
            });
        };

        const cleanup = (): void => {
            closed = true;
            for (const controller of running.values()) {
                controller.abort();
            }
            running.clear();
            unregisterAccess?.();
        };

        return {
            onOpen: (_event, ws) => {
                try {
                    // Speaking costs this box's cores or the owner's provider credits: the collaborator's grant, as
                    // dictating is.
                    const caller = redeemTicket(services, new URL(c.req.url).searchParams, "collaborator");
                    if (caller !== undefined) {
                        unregisterAccess = services.auth?.connections.register(caller, () => ws.close(1008, "authorization revoked"));
                    }
                } catch (error) {
                    services.logger.warn({ err: error }, "voice stream ticket rejected");
                    ws.close(1008, "unauthorized");
                }
            },
            onMessage: (event, ws) => {
                // The player sends no audio; a binary frame is no message of this protocol.
                if (closed || binaryFrame(event.data) !== undefined) {
                    return;
                }
                let parsed: unknown;
                try {
                    parsed = JSON.parse(String(event.data));
                } catch {
                    // allow(silent-catch): a text frame that is not JSON is no message of the protocol, dropped like one the schema refuses below
                    return;
                }
                const message = VoiceClientMessageSchema.safeParse(parsed);
                if (!message.success) {
                    send(ws, { type: "error", message: `not a voice message: ${message.error.issues[0]?.message ?? "invalid"}` });
                    return;
                }
                if (message.data.type === "say") {
                    say(ws, message.data);
                    return;
                }
                running.get(message.data.id)?.abort();
            },
            onClose: cleanup,
            onError: cleanup,
        };
    });
