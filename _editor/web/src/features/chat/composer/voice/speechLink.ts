import { sleep } from "@intentic/base/async";
import { type SpeechClientMessage, SpeechServerMessageSchema, type SpeechStatus } from "@intentic/sandbox-contract";
import { SandboxHttpError } from "../../../../client/sandbox/sandboxHttpError";
import { sandboxRaw } from "../../../../client/sandbox/sandboxRaw";
import { liveSocket, type LiveTiming, webSocketChannel } from "../../../../client/session/liveSocket";
import { socketUrl } from "../../../sandbox/session/wsTicket";
import { pcm16Of, wavOf16k } from "./voiceAudio";

// The composer's wire to the sandbox's speech engine, one per press. Phrases are handed over as they are spoken: on the
// daemon's live stream (GET /speech/stream, schemas/speech.ts) that is the audio itself, so running guesses come back
// mid-phrase and the model's readiness is pushed; on a daemon older than the stream it is one WAV per ended phrase
// (POST /speech/transcribe), with readiness polled. Which one is decided while the person already speaks: everything
// said before the socket answers is held and replayed into whichever transport takes it, so nothing is lost to the
// choice. The stream is a live socket (liveSocket.ts): pinged, and dialled again on a short ladder when it drops, so a
// daemon restarting under a long dictation costs only the phrases in flight.

export type SpeechTransport = `stream` | `http`;

export type SpeechLinkFailure =
    /** This machine has no speech runtime (the daemon said provisioned: false). */
    | `unprovisioned`
    /** The daemon has no speech routes at all: older than voice. */
    | `unavailable`
    /** One phrase could not be heard; the rest go on. */
    | `phrase`;

export interface SpeechLinkEvents {
    readonly status: (status: SpeechStatus) => void;
    readonly partial: (id: number, text: string) => void;
    /** A phrase's words, empty when it held none; `decodeMs` is the daemon's own measure when it gave one. */
    readonly final: (id: number, text: string, decodeMs: number | undefined) => void;
    readonly failed: (id: number | undefined, failure: SpeechLinkFailure) => void;
    /** Which transport took the link, once it is decided. */
    readonly transport?: (transport: SpeechTransport) => void;
}

export interface SpeechLink {
    readonly begin: (id: number, opening: Float32Array) => void;
    readonly audio: (id: number, frame: Float32Array) => void;
    readonly end: (id: number, samples: Float32Array) => void;
    readonly drop: (id: number) => void;
    /** Let go: stops polling and closes the socket; phrases still in flight are abandoned. */
    readonly close: () => void;
}

type Op =
    | { readonly kind: `begin`; readonly id: number; readonly samples: Float32Array }
    | { readonly kind: `audio`; readonly id: number; readonly samples: Float32Array }
    | { readonly kind: `end`; readonly id: number; readonly samples: Float32Array }
    | { readonly kind: `drop`; readonly id: number };

interface Transport {
    readonly apply: (op: Op) => void;
    readonly close: () => void;
}

/** The seams a test replaces: how a socket address is minted and a socket opened, and how the daemon is asked. */
export interface SpeechLinkDeps {
    readonly socketUrl: (path: string, extra: Record<string, string>) => Promise<string | undefined>;
    readonly openSocket: (url: string) => WebSocket;
    readonly raw: typeof sandboxRaw;
    readonly pollMs: number;
    // The live socket's clock. Someone is speaking while it redials, so its first rung is short.
    readonly timing: Partial<LiveTiming>;
}

const DEFAULT_DEPS: SpeechLinkDeps = {
    socketUrl,
    openSocket: (url) => new WebSocket(url),
    raw: sandboxRaw,
    pollMs: 2500,
    timing: { retryMs: 250, maxRetryMs: 8000 },
};

// What goes out on the stream: the protocol's messages as JSON, and a phrase's audio as the bytes themselves.
type StreamOut = SpeechClientMessage | ArrayBuffer;

// What the daemon says on the stream, one text frame at a time. A frame that is not JSON, or not one of its messages, is
// ignored.
const heard = (text: string, events: SpeechLinkEvents, inFlight: Set<number>): void => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
        // allow(silent-catch): A frame that is not JSON is not one of the daemon's messages, and is ignored like one that fails the schema.
    } catch {
        return;
    }
    const message = SpeechServerMessageSchema.safeParse(parsed);
    if (!message.success) {
        return;
    }
    const said = message.data;
    switch (said.type) {
        case `status`:
            events.status(said.status);
            if (!said.status.provisioned) {
                events.failed(undefined, `unprovisioned`);
            }
            return;
        case `partial`:
            events.partial(said.id, said.text);
            return;
        case `final`:
            inFlight.delete(said.id);
            events.final(said.id, said.text, said.decodeMs);
            return;
        case `error`:
            if (said.id !== undefined) {
                inFlight.delete(said.id);
            }
            events.failed(said.id, `phrase`);
            return;
    }
};

// A daemon without the stream: each ended phrase as one WAV, posted in order once the model is on disk, and the model's
// readiness polled meanwhile (a 409 is "still downloading": the phrase waits and the poll resumes).
const httpTransport = (lang: string, events: SpeechLinkEvents, deps: SpeechLinkDeps): Transport => {
    const controller = new AbortController();
    const { signal } = controller;
    const open = new Map<number, Float32Array[]>();
    const queue: { readonly id: number; readonly samples: Float32Array }[] = [];
    let ready = false;
    let polling = false;
    let draining = false;

    const poll = async (): Promise<void> => {
        if (polling) {
            return;
        }
        polling = true;
        try {
            while (!signal.aborted && !ready) {
                const status = await deps.raw(`GET /speech/status`, { query: { lang }, signal });
                if (signal.aborted) {
                    return;
                }
                events.status(status);
                if (!status.provisioned) {
                    events.failed(undefined, `unprovisioned`);
                    return;
                }
                if (status.model === `ready`) {
                    ready = true;
                    void drain();
                    return;
                }
                await sleep(deps.pollMs, { signal });
            }
        } catch (cause) {
            if (!signal.aborted) {
                events.failed(undefined, cause instanceof SandboxHttpError && cause.status === 501 ? `unprovisioned` : `unavailable`);
            }
        } finally {
            polling = false;
        }
    };

    const drain = async (): Promise<void> => {
        if (draining) {
            return;
        }
        draining = true;
        try {
            while (ready && !signal.aborted && queue.length > 0) {
                const next = queue[0];
                if (next === undefined) {
                    break;
                }
                try {
                    const startedAt = Date.now();
                    const { text } = await deps.raw(`POST /speech/transcribe`, { query: { lang }, input: wavOf16k(next.samples), signal });
                    queue.shift();
                    events.final(next.id, text, Date.now() - startedAt);
                } catch (cause) {
                    if (signal.aborted) {
                        return;
                    }
                    if (cause instanceof SandboxHttpError && cause.status === 409) {
                        // The model went missing again (a cache wiped under it): wait for it, keep the phrase.
                        ready = false;
                        void poll();
                        return;
                    }
                    queue.shift();
                    events.failed(next.id, cause instanceof SandboxHttpError && cause.status === 501 ? `unprovisioned` : `phrase`);
                }
            }
        } finally {
            draining = false;
        }
    };

    void poll();
    return {
        apply: (op) => {
            switch (op.kind) {
                case `begin`:
                    open.set(op.id, [op.samples]);
                    return;
                case `audio`:
                    open.get(op.id)?.push(op.samples);
                    return;
                case `drop`:
                    open.delete(op.id);
                    return;
                case `end`:
                    open.delete(op.id);
                    queue.push({ id: op.id, samples: op.samples });
                    if (ready) {
                        void drain();
                    } else {
                        void poll();
                    }
                    return;
            }
        },
        close: () => controller.abort(),
    };
};

/** How the link is opened: `guesses: false` asks the daemon for finals alone (the wake listener, which reads no guess). */
export interface SpeechLinkOptions {
    readonly guesses?: boolean;
}

export const openSpeechLink = (
    lang: string,
    events: SpeechLinkEvents,
    overrides: Partial<SpeechLinkDeps> = {},
    options: SpeechLinkOptions = {},
): SpeechLink => {
    const deps = { ...DEFAULT_DEPS, ...overrides };
    let transport: Transport | undefined;
    let closed = false;
    // What was said before a transport took the link, replayed into it in order.
    const held: Op[] = [];
    // The phrases the current transport saw begin: one begun on a socket since lost cannot be finished on the next, so
    // its end is a lost phrase rather than a wait for a final that never comes.
    const begun = new Set<number>();
    // The phrases ended on the stream and not yet answered.
    const inFlight = new Set<number>();
    // Whether the dial in hand got as far as opening: a socket that never opens is a daemon with no stream route, and one
    // that opened and dropped is a restart to ride out.
    let up = false;
    let onHttp = false;

    const forward = (to: Transport, op: Op): void => {
        if (op.kind === `begin`) {
            begun.add(op.id);
        } else if (!begun.has(op.id)) {
            if (op.kind === `end`) {
                events.failed(op.id, `phrase`);
            }
            return;
        } else if (op.kind !== `audio`) {
            begun.delete(op.id);
        }
        to.apply(op);
    };

    const settle = (chosen: Transport, name: SpeechTransport): void => {
        if (closed) {
            chosen.close();
            return;
        }
        transport = chosen;
        begun.clear();
        events.transport?.(name);
        for (const op of held.splice(0)) {
            forward(chosen, op);
        }
    };

    // The stream: the daemon hears, guesses and reports; this only frames what the segmenter says.
    const live = liveSocket<string, StreamOut>({
        // allow(silent-catch): A socket address that cannot be had is the undefined below, which falls back to posting each phrase over HTTP.
        mint: () => deps.socketUrl(`/speech/stream`, options.guesses === false ? { lang, guesses: `0` } : { lang }).catch(() => undefined),
        open: webSocketChannel<StreamOut>({ text: (text) => heard(text, events, inFlight), binary: () => undefined }, deps.openSocket),
        onOpen: () => {
            up = true;
            settle(stream, `stream`);
        },
        onUnreachable: () => fallBack(),
        onDrop: () => {
            if (!up) {
                // An upgrade the daemon refused: no stream route there, so its WAV door.
                fallBack();
                return;
            }
            // A socket that dies after it was up (a daemon restart) costs only the phrases in flight; the next phrase waits
            // for the socket dialled in its place.
            up = false;
            for (const id of inFlight) {
                events.failed(id, `phrase`);
            }
            inFlight.clear();
            transport = undefined;
        },
        // The speech route answers no ping, so silence says nothing about it.
        staleCheck: `once-ponged`,
        timing: deps.timing,
    });

    const stream: Transport = {
        apply: (op) => {
            if (!live.isOpen()) {
                if (op.kind === `end`) {
                    events.failed(op.id, `phrase`);
                }
                return;
            }
            switch (op.kind) {
                case `begin`:
                    live.send({ type: `begin`, id: op.id });
                    live.send(pcm16Of(op.samples));
                    return;
                case `audio`:
                    live.send(pcm16Of(op.samples));
                    return;
                case `end`:
                    inFlight.add(op.id);
                    live.send({ type: `end`, id: op.id, keep: op.samples.length });
                    return;
                case `drop`:
                    live.send({ type: `drop`, id: op.id });
                    return;
            }
        },
        close: () => live.dispose(),
    };

    const fallBack = (): void => {
        live.end();
        if (!onHttp) {
            onHttp = true;
            settle(httpTransport(lang, events, deps), `http`);
        }
    };

    live.connect();

    const apply = (op: Op): void => {
        if (closed) {
            return;
        }
        if (transport === undefined) {
            held.push(op);
            return;
        }
        forward(transport, op);
    };

    return {
        begin: (id, opening) => apply({ kind: `begin`, id, samples: opening }),
        audio: (id, frame) => apply({ kind: `audio`, id, samples: frame }),
        end: (id, samples) => apply({ kind: `end`, id, samples }),
        drop: (id) => apply({ kind: `drop`, id }),
        close: () => {
            closed = true;
            held.length = 0;
            transport?.close();
            transport = undefined;
            // Whichever transport was chosen, the socket is let go with the link: one still dialling must not open later.
            live.dispose();
        },
    };
};

/** Fetch and load the model for this language ahead of the press, where the daemon knows how; quietly nothing elsewhere. */
export const prepareSpeech = (lang: string, ask: typeof sandboxRaw = sandboxRaw): Promise<SpeechStatus | undefined> =>
    // allow(silent-catch): Preparing ahead is only a head start; a refusal leaves the first press to load the model itself.
    ask(`POST /speech/prepare`, { query: { lang } }).catch(() => undefined);
