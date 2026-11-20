import type { BrowserMediaClientMessage } from "@intentic/sandbox-contract/browser-wire";
import { ref, type Ref, shallowRef } from "vue";
import { type ClipboardOut, stageClipboard } from "./clipboardOut";
import { cursorCss, supportsImageSetCursor } from "./cursorCss";
import type { MediaStats } from "./frameBook";
import { type MediaHello, type MediaOffer, type MediaServerMessage, readMediaText } from "./mediaMessages";
import { mediaRtc, type PeerLike } from "./mediaRtc";
import { mediaSize } from "./mediaSize";
import { windowOf } from "./pixelRatio";
import { mediaSocket, type MediaSocket } from "./mediaSocket";
import { mediaSound, type MediaSound } from "./sound/mediaSound";
import { type MediaWorker, startMediaWorker } from "./mediaWorker";
import type { FromWorker } from "./worker/workerWire";

// ONE LIVE PICTURE ON ITS MEDIA SOCKET, AS THE PAGE HOLDS IT. The window's own socket (browser view, desktop view, a
// sign-in window) names castd's address in `media`; from then on the picture, the sound, the pointer and keys, the
// clipboard and the box travel on the media socket, which a decode worker holds and draws from (decodeCore.ts). The
// page keeps what it acts on: castd's `hello` (the picture's size and scale, whether this viewer may drive), the
// cursor, a copy made in the window, the stats while shown, and the sound's controls. useScreencast composes this
// beside the window's own socket. Where castd offers one, a peer connection straight to it (mediaRtc.ts) carries the
// stream and the viewer's messages beside the socket, which stays as control and fallback.

interface Size {
    readonly width: number;
    readonly height: number;
}

export interface MediaPicture {
    // A hello came on the socket now open: the picture is this socket's, and input goes on it.
    readonly live: Ref<boolean>;
    readonly hello: Ref<MediaHello | undefined>;
    // The canvas's size in its own pixels, from its first frame of each size.
    readonly painted: Ref<Size | undefined>;
    // A frame has been drawn since the last hello.
    readonly pictured: Ref<boolean>;
    readonly cursor: Ref<string>;
    readonly stats: Ref<MediaStats | undefined>;
    readonly sound: MediaSound;
    // Why no picture will ever come (this browser cannot decode castd's stream).
    readonly failed: Ref<string | undefined>;
    readonly offer: (offer: MediaOffer) => void;
    readonly send: (message: BrowserMediaClientMessage) => void;
    readonly attach: (canvas: HTMLCanvasElement | null) => void;
    readonly requestSize: (width: number, height: number) => void;
    readonly setVisible: (visible: boolean) => void;
    // The tab the picture shows (window and page); `switching` when the person picked it.
    readonly showPage: (key: string, switching: boolean) => void;
    readonly fronted: (key: string) => void;
    readonly showStats: (on: boolean) => void;
    readonly edgeColour: () => string | undefined;
    // The stage changed size: the worker reads the edge colour again.
    readonly sampleEdge: () => void;
    // A press or key in the stage: a held copy is written, and sound may start.
    readonly gesture: () => void;
    // Back to the window's own socket's picture (it sent `ready`), or another window: everything goes but the tabs'
    // last pictures.
    readonly stop: () => void;
    readonly dispose: () => void;
}

export interface MediaPictureOptions {
    readonly base: () => string | undefined;
    readonly askFresh: () => void;
    // Called as each hello lands, after this view's own state took it.
    readonly onHello?: (hello: MediaHello) => void;
    readonly onPicture?: () => void;
    readonly onDrop?: () => void;
    // Whether the edge in front of the sandbox declared WebTransport (the socket may ride its session), and whether a
    // peer connection could be any shorter than the socket's way (not on the loopback shortcut). Neither by default.
    readonly webTransport?: () => boolean;
    readonly peerWanted?: () => boolean;
    // This browser cannot decode castd's stream, in the decoder's words: no picture will come on this path.
    readonly onFailed?: (message: string) => void;
    // Seams for a test: the worker, the clipboard's, and the peer connection.
    readonly worker?: () => MediaWorker | undefined;
    readonly clipboard?: ClipboardOut;
    readonly peer?: () => PeerLike | undefined;
}

// What the page shows of the picture, and how it is forgotten when the picture goes.
const pictureRefs = () => {
    const refs = {
        live: ref(false),
        hello: shallowRef<MediaHello | undefined>(),
        painted: shallowRef<Size | undefined>(),
        pictured: ref(false),
        cursor: ref(`default`),
        stats: shallowRef<MediaStats | undefined>(),
        failed: ref<string | undefined>(),
    };
    let edge: string | undefined;
    return {
        refs,
        edge: () => edge,
        setEdge: (colour: string | undefined): void => {
            edge = colour;
        },
        clear: (): void => {
            refs.live.value = false;
            refs.hello.value = undefined;
            refs.painted.value = undefined;
            refs.pictured.value = false;
            refs.cursor.value = `default`;
            refs.failed.value = undefined;
            edge = undefined;
        },
    };
};

// Where the worker's word goes besides the page's refs: anything about the socket to the socket, what it would send on
// the socket while the peer carries the viewer's messages to the peer, a stream this browser cannot decode to whoever
// falls back, and a drawn picture to the page.
interface WorkerOutlets {
    readonly socket: { readonly fromWorker: (message: FromWorker) => void };
    readonly peerSend: (message: BrowserMediaClientMessage) => void;
    readonly failed: ((message: string) => void) | undefined;
    readonly picture: () => void;
}

// What the worker says about the picture itself, onto the page's refs, and the rest to its outlet.
const workerReader =
    (state: ReturnType<typeof pictureRefs>, sound: MediaSound, to: WorkerOutlets) =>
    (message: FromWorker): void => {
        const { refs } = state;
        if (message.type === `peerSend`) {
            to.peerSend(message.message);
        } else if (message.type === `painted`) {
            refs.painted.value = { width: message.width, height: message.height };
        } else if (message.type === `picture`) {
            refs.pictured.value = true;
            to.picture();
        } else if (message.type === `edge`) {
            state.setEdge(message.colour);
        } else if (message.type === `stats`) {
            refs.stats.value = { ...message.stats, audioMs: sound.report.value?.fillMs, audioTargetMs: sound.report.value?.targetMs };
        } else if (message.type === `failed`) {
            refs.failed.value = message.message;
            to.failed?.(message.message);
        } else {
            to.socket.fromWorker(message);
        }
    };

// castd's JSON as the page acts on it, from either carrier: a hello is the picture's geometry and who may drive, a
// cursor the pointer's look, a copy for the person's clipboard; anything about the peer goes to the peer.
const textReader =
    (parts: {
        readonly state: ReturnType<typeof pictureRefs>;
        readonly sound: MediaSound;
        readonly size: ReturnType<typeof mediaSize>;
        readonly clipboard: ClipboardOut;
        readonly onHello: ((hello: MediaHello) => void) | undefined;
        readonly signalled: (message: MediaServerMessage | undefined) => void;
    }) =>
    (data: string): void => {
        const { refs } = parts.state;
        const message = readMediaText(data);
        parts.signalled(message);
        if (message?.type === `hello`) {
            refs.hello.value = message;
            refs.live.value = true;
            refs.pictured.value = false;
            parts.sound.hello(message.audio);
            parts.size.fresh();
            parts.onHello?.(message);
        } else if (message?.type === `cursor`) {
            refs.cursor.value = cursorCss(message.cursor, refs.hello.value?.scale ?? 1, supportsImageSetCursor());
        } else if (message?.type === `clipboard` && refs.hello.value?.readOnly === false) {
            // A read-only viewer watches: nothing the window copies is written over its clipboard.
            parts.clipboard.remote(message.content);
        }
    };

// The stage changes size every frame of a drag, and each read of the edge copies the picture back off the GPU in the
// worker: one is asked at most every EDGE_SAMPLE_MS. A new size's first frame is read in the worker anyway.
const EDGE_SAMPLE_MS = 250;
const edgeSampler = (ask: () => void, now: () => number = Date.now) => {
    let askedAt = Number.NEGATIVE_INFINITY;
    return (): void => {
        if (now() - askedAt >= EDGE_SAMPLE_MS) {
            askedAt = now();
            ask();
        }
    };
};

// Whether anyone can see the picture, said to castd only as it changes, since castd restarts this viewer's video with a
// keyframe at every `resume`; and said whole on every fresh socket.
const visibility = (send: (message: BrowserMediaClientMessage) => void) => {
    let visible = true;
    return {
        visible: () => visible,
        set: (on: boolean): void => {
            if (on !== visible) {
                send({ type: on ? `resume` : `pause` });
            }
            visible = on;
        },
        opened: (): void => send({ type: visible ? `resume` : `pause` }),
    };
};

export const mediaPicture = (options: MediaPictureOptions): MediaPicture => {
    const state = pictureRefs();
    const { live, hello } = state.refs;
    const seen = visibility((message) => send(message));
    // The stage's own document, which a popped-out window's press focuses rather than this one.
    let stage: HTMLCanvasElement | undefined;
    const clipboard = options.clipboard ?? stageClipboard(() => stage);
    const parts = workerParts(options.worker ?? startMediaWorker, (message) => reader(message));

    const send = (message: BrowserMediaClientMessage): void => {
        if (!peer.send(message)) {
            socket.live.send(message);
        }
    };
    const sound = mediaSound({
        ask: (on) => send({ type: `audio`, on }),
        feed: (port) => parts.post({ type: `audio`, port }, port === undefined ? [] : [port]),
    });
    const drives = (): boolean => live.value && hello.value?.readOnly === false;
    const stageWindow = (): Window => windowOf(stage);
    const size = mediaSize((box) => send({ type: `resize`, ...box }), drives, stageWindow);

    const onText = textReader({ state, sound, size, clipboard, onHello: options.onHello, signalled: (message) => peer.signalled(message) });

    const socket = mediaSocket({
        worker: parts.worker,
        base: options.base,
        askFresh: options.askFresh,
        onText,
        webTransport: options.webTransport,
        onOpen: () => {
            size.opened();
            seen.opened();
        },
        onDrop: () => {
            peer.stop();
            live.value = false;
            sound.shown(false);
            options.onDrop?.();
        },
    });
    const peer = peerPath(options, parts, socket, onText);
    const reader = workerReader(state, sound, {
        socket,
        peerSend: peer.peerSend,
        failed: options.onFailed,
        picture: () => {
            sound.shown(seen.visible());
            options.onPicture?.();
        },
    });

    const stop = (): void => {
        peer.stop();
        socket.stop();
        state.clear();
        sound.close();
        clipboard.forget();
        parts.post({ type: `reset` });
    };

    return {
        ...state.refs,
        sound,
        offer: (offer) => {
            parts.worker();
            socket.offer(offer);
        },
        send,
        attach: (canvas) => {
            stage = canvas ?? stage;
            size.moved();
            parts.attach(canvas);
        },
        requestSize: size.measured,
        setVisible: (on) => {
            seen.set(on);
            sound.shown(on && state.refs.pictured.value);
        },
        showPage: (key, switching) => parts.post({ type: `page`, key, switching }),
        fronted: (key) => parts.post({ type: `fronted`, key }),
        showStats: (on) => parts.post({ type: `stats`, on }),
        edgeColour: state.edge,
        sampleEdge: edgeSampler(() => parts.post({ type: `edge` })),
        gesture: () => {
            clipboard.gesture();
            sound.gesture();
        },
        stop,
        dispose: () => {
            stop();
            size.dispose();
            socket.live.dispose();
            parts.terminate();
        },
    };
};

// The peer connection beside the socket (mediaRtc.ts), wired to the page and the worker: what arrives on it reaches both
// as the socket's own messages do, the viewer's messages go on it while it is open, and castd's word about it (from
// either carrier) goes to it.
const peerPath = (options: MediaPictureOptions, parts: ReturnType<typeof workerParts>, socket: MediaSocket, onText: (data: string) => void) => {
    const rtc = mediaRtc({
        signal: (message) => socket.live.send(message),
        arrived: (data) => {
            socket.heard();
            if (data instanceof ArrayBuffer) {
                parts.post({ type: `peerData`, data }, [data]);
            } else {
                onText(data);
                parts.post({ type: `peerData`, data });
            }
        },
        carrying: (open) => parts.post({ type: `peer`, open }),
        wanted: options.peerWanted ?? (() => false),
        peer: options.peer,
    });
    return {
        send: rtc.send,
        stop: rtc.stop,
        signalled: (message: MediaServerMessage | undefined): void => {
            if (message?.type === `hello`) {
                rtc.hello(message.rtc === true);
            } else if (message?.type === `rtcAnswer`) {
                rtc.answer(message.sdp);
            } else if (message?.type === `rtcClosed`) {
                rtc.closed(message.reason);
            }
        },
        // What the worker would have sent on the socket while the peer carried the viewer's messages. A peer that closed
        // since leaves it to the socket, once the worker has heard so.
        peerSend: (message: BrowserMediaClientMessage): void => {
            if (!rtc.send(message)) {
                parts.post({ type: `peer`, open: false });
                parts.post({ type: `send`, message });
            }
        },
    };
};

const NO_WORKER = `This browser cannot decode the picture off its main thread (no OffscreenCanvas or VideoDecoder).`;

// The decode worker, started at the first offer, and the canvas handed to it: an element's drawing can be handed to a
// worker once, so each canvas element is transferred the first time it comes and let go of when it goes.
const workerParts = (start: () => MediaWorker | undefined, listen: (message: FromWorker) => void) => {
    let worker: MediaWorker | undefined;
    let canvas: HTMLCanvasElement | undefined;
    const transferred = new WeakSet<HTMLCanvasElement>();
    // Messages for a worker that could not start go nowhere, and it says it failed, so the window's own socket's picture
    // takes over at once rather than once no hello came in GIVE_UP_MS.
    const fallback: MediaWorker = {
        post: () => undefined,
        listen: (handler) => queueMicrotask(() => handler({ type: `failed`, message: NO_WORKER })),
        terminate: () => undefined,
    };
    const handOver = (at: MediaWorker): void => {
        if (canvas === undefined || transferred.has(canvas) || at === fallback) {
            return;
        }
        transferred.add(canvas);
        const offscreen = canvas.transferControlToOffscreen();
        at.post({ type: `canvas`, canvas: offscreen }, [offscreen]);
    };
    const get = (): MediaWorker => {
        if (worker === undefined) {
            worker = start() ?? fallback;
            worker.listen(listen);
            handOver(worker);
        }
        return worker;
    };
    return {
        worker: get,
        post: (message: Parameters<MediaWorker[`post`]>[0], transfer?: Transferable[]): void => worker?.post(message, transfer),
        attach: (element: HTMLCanvasElement | null): void => {
            canvas = element ?? undefined;
            if (element === null) {
                worker?.post({ type: `canvas`, canvas: undefined });
            } else if (worker !== undefined) {
                handOver(worker);
            }
        },
        terminate: (): void => worker?.terminate(),
    };
};
