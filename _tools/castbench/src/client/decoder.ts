import { sleep } from "@intentic/base/async";
import {
    BROWSER_FRAME_TAGS,
    type BrowserMediaClientMessage,
    type BrowserViewClientMessage,
    RTC_CHANNELS,
    type RtcChannelLabel,
} from "@intentic/sandbox-contract/browser-wire";
import { MARKER, MARKER_HEIGHT, MARKER_WIDTH, type MarkerValue, readMarkerPlane } from "../marker.js";
import { chunkJoiner, isVideo, mediaPayload, parseMediaHeader } from "../media-wire.js";

// The viewer: a page in a headless Chromium that opens the stream the way the editor does and decodes it with the same
// decoder, WebCodecs' VideoDecoder configured as videoSink.ts configures it (Annex B, no description, optimizeForLatency).
// Instead of painting, it copies the marker's corner of each decoded frame's luma plane and reads the marker there, so
// what it times is decode output, never a canvas readback. It logs raw events with their times; the harness (analysis.ts)
// turns them into numbers.
//
// Two wires: `legacy`, the browser view socket as live-view.ts speaks it (a `ready` naming the codec, then one tagged
// access unit per message); and `media`, browser-wire's media socket as castd speaks it (`hello`, 16-byte headers, a
// picture possibly cut into stripes with a decoder each, and an `ack` per decoded frame, which castd's rate control reads).
//
// With `peer`, the media wire moves onto a peer connection straight to castd where castd's hello offers one, as the
// editor's mediaRtc.ts does: the offer and answer on the socket, then castd's hello, pictures and JSON on the `media`
// channel and the viewer's own messages on `input`. Pictures count only from the carrier of the latest hello.

export type Protocol = "legacy" | "media";

export interface DecoderConfig {
    readonly url: string;
    readonly protocol: Protocol;
    // Move the stream onto a peer connection when castd's hello offers one.
    readonly peer?: boolean;
}

// [frame, ms, decodedAt]: a marker read off a decoded frame.
export type MarkerRecord = readonly [number, number, number];

export interface InputRecord {
    readonly kind: "key" | "paste";
    readonly at: number;
    // The length the typing page's marker shows once this input has landed.
    readonly expect: number;
    readonly echoedAt: number | null;
}

export interface DecoderLog {
    readonly picture: { readonly width: number; readonly height: number } | null;
    readonly markers: readonly MarkerRecord[];
    // When each video frame came out of the decoder.
    readonly decoded: readonly number[];
    // [receivedAt, bytes] per message.
    readonly received: readonly (readonly [number, number])[];
    readonly inputs: readonly InputRecord[];
    readonly markerErrors: number;
    readonly decodeErrors: number;
    readonly keyframes: number;
    readonly closed: string | null;
    // Which carrier the stream was on as the run ended, when the peer's channels opened, and why castd closed a peer.
    readonly carrier: Carrier;
    readonly peerOpenedAt: number | null;
    readonly peerClosed: string | null;
}

export type Carrier = "socket" | "peer";

export interface TypingPlan {
    // Keystrokes are sent until this time (epoch ms), then the pastes.
    readonly keysUntil: number;
    readonly pastes: number;
    readonly pasteChars: number;
}

const now = (): number => performance.timeOrigin + performance.now();

// One access unit's slot on the decoder's clock: the editor's 30 fps step (videoSink.ts); only its order matters.
const FRAME_US = Math.round(1_000_000 / 30);
// A stripe's decoder, for the media wire; the legacy wire has one, index 0.
interface Stripe {
    readonly decoder: VideoDecoder;
    top: number;
    awaitingKey: boolean;
}

const markers: MarkerRecord[] = [];
const decoded: number[] = [];
const received: (readonly [number, number])[] = [];
const inputs: InputRecord[] = [];
let picture: { width: number; height: number } | null = null;
let markerErrors = 0;
let decodeErrors = 0;
let keyframes = 0;
let closed: string | null = null;
let socket: WebSocket | undefined;
let protocol: Protocol = "legacy";
let codec = "";
const stripes = new Map<number, Stripe>();
// Media wire: how many stripes of a frame id are still to decode, and when its first was handed to a decoder.
const outstanding = new Map<number, { left: number; submittedAt: number }>();
// The typing page's length as last decoded, and whoever waits for it to reach a value.
let shownLength = 0;
let waiter: { readonly expect: number; readonly resolve: (at: number) => void } | undefined;

// The peer connection, once castd offered one and the run asked for it.
let carrier: Carrier = "socket";
let peer: RTCPeerConnection | undefined;
let input: RTCDataChannel | undefined;
let peerOpenedAt: number | null = null;
let peerClosed: string | null = null;
let wantPeer = false;

const sendJson = (message: BrowserMediaClientMessage | BrowserViewClientMessage): void => {
    // Signalling is the socket's; everything else goes on the peer while its `input` is open.
    if (input?.readyState === "open" && !message.type.startsWith("rtc")) {
        input.send(JSON.stringify(message));
        return;
    }
    socket?.send(JSON.stringify(message));
};

const onMarker = (value: MarkerValue, at: number): void => {
    markers.push([value.frame, value.ms, at]);
    shownLength = value.frame;
    if (waiter !== undefined && value.frame === waiter.expect) {
        waiter.resolve(at);
        waiter = undefined;
    }
};

// Reads the marker off a decoded frame whose top row is `top` in the picture, when the frame holds the marker's rows.
const readFrame = async (frame: VideoFrame, top: number, at: number): Promise<void> => {
    const y = MARKER.y - top;
    if (y < 0 || y + MARKER_HEIGHT > frame.codedHeight || MARKER.x + MARKER_WIDTH > frame.codedWidth) {
        return;
    }
    const rect = { x: MARKER.x, y, width: MARKER_WIDTH, height: MARKER_HEIGHT };
    const buffer = new Uint8Array(frame.allocationSize({ rect }));
    const [luma] = await frame.copyTo(buffer, { rect });
    const value = luma === undefined ? undefined : readMarkerPlane(buffer.subarray(luma.offset), luma.stride);
    if (value === undefined) {
        markerErrors += 1;
        return;
    }
    onMarker(value, at);
};

const stripeFor = (index: number, top: number): Stripe => {
    const known = stripes.get(index);
    if (known !== undefined) {
        known.top = top;
        return known;
    }
    const stripe: Stripe = {
        top,
        awaitingKey: true,
        decoder: new VideoDecoder({
            output: (frame) => {
                const at = now();
                decoded.push(at);
                // The announced size wins; a stream that announced none is as large as its first whole frame.
                picture ??= { width: frame.displayWidth, height: frame.displayHeight };
                const id = frame.timestamp;
                void readFrame(frame, stripe.top, at)
                    .catch(() => {
                        markerErrors += 1;
                    })
                    .finally(() => frame.close());
                if (protocol === "media") {
                    const pending = outstanding.get(id);
                    if (pending !== undefined) {
                        pending.left -= 1;
                        if (pending.left <= 0) {
                            outstanding.delete(id);
                            sendJson({ type: "ack", id, decodeMs: Math.round((at - pending.submittedAt) * 10) / 10 });
                        }
                    }
                }
            },
            error: () => {
                decodeErrors += 1;
                stripes.delete(index);
                sendJson({ type: "keyframe" });
            },
        }),
    };
    stripe.decoder.configure({ codec, optimizeForLatency: true });
    stripes.set(index, stripe);
    return stripe;
};

let legacyStamp = 0;

const decode = (stripe: Stripe, payload: Uint8Array, key: boolean, timestamp: number): void => {
    if (stripe.awaitingKey && !key) {
        return;
    }
    stripe.awaitingKey = false;
    if (key) {
        keyframes += 1;
    }
    try {
        stripe.decoder.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp, data: payload }));
    } catch {
        decodeErrors += 1;
        stripe.awaitingKey = true;
        sendJson({ type: "keyframe" });
    }
};

const resetDecoders = (): void => {
    for (const stripe of stripes.values()) {
        if (stripe.decoder.state !== "closed") {
            stripe.decoder.close();
        }
    }
    stripes.clear();
    outstanding.clear();
};

const onText = (text: string, from: Carrier = "socket"): void => {
    let message: { type?: string; codec?: string; width?: number; height?: number; rtc?: boolean; sdp?: string; reason?: string };
    try {
        // SAFETY: only the fields named in the type are read below, each compared or checked for presence first.
        message = JSON.parse(text) as typeof message;
    } catch {
        // allow(silent-catch): a text message that is not JSON names no stream; the viewer waits for one that does.
        return;
    }
    if (message.type === "rtcAnswer" && message.sdp !== undefined) {
        void peer?.setRemoteDescription({ type: "answer", sdp: message.sdp });
        return;
    }
    if (message.type === "rtcClosed") {
        peerClosed = message.reason ?? "";
        return;
    }
    // `ready` on the browser view socket, `hello` on the media socket: a fresh stream, whose first frame is a keyframe.
    if ((message.type === "ready" || message.type === "hello") && message.codec !== undefined) {
        carrier = from;
        if (message.type === "hello" && message.rtc === true && wantPeer && peer === undefined) {
            void startPeer();
        }
        codec = message.codec;
        resetDecoders();
        picture = message.width === undefined || message.height === undefined ? picture : { width: message.width, height: message.height };
        if (message.type === "hello" && picture !== null) {
            // The pointer over the picture, as when the person's hand enters it: on a display with no window manager the
            // keyboard goes to the window under the pointer, so keys sent as XTEST reach the page only from here.
            sendJson({ type: "mouse", action: "move", x: picture.width / 2, y: picture.height / 2 });
        }
    }
};

const onBinary = (bytes: Uint8Array, from: Carrier = "socket"): void => {
    if (codec === "" || from !== carrier) {
        return;
    }
    if (protocol === "legacy") {
        const tag = bytes[0];
        const key = tag === BROWSER_FRAME_TAGS.h264Key || tag === BROWSER_FRAME_TAGS.h264KeyQuiet;
        const delta = tag === BROWSER_FRAME_TAGS.h264Delta || tag === BROWSER_FRAME_TAGS.h264DeltaQuiet;
        if (key || delta) {
            legacyStamp += FRAME_US;
            decode(stripeFor(0, 0), bytes.subarray(1), key, legacyStamp);
        }
        return;
    }
    const header = parseMediaHeader(bytes);
    if (header === undefined || !isVideo(header)) {
        return;
    }
    const pending = outstanding.get(header.id);
    if (pending === undefined) {
        outstanding.set(header.id, { left: Math.max(1, header.stripeCount), submittedAt: now() });
    }
    decode(stripeFor(header.stripeIndex, header.stripeTop), mediaPayload(bytes), header.key, header.id);
};

// The peer connection beside the socket: the three channels with browser-wire's reliability, the offer on the socket.
const startPeer = async (): Promise<void> => {
    const pc = new RTCPeerConnection({ iceServers: [] });
    peer = pc;
    const join = chunkJoiner();
    const labels: readonly RtcChannelLabel[] = ["media", "audio", "input"];
    for (const label of labels) {
        const reliability = RTC_CHANNELS[label];
        const init: RTCDataChannelInit = { ordered: reliability.ordered };
        if (reliability.maxRetransmits !== null) {
            init.maxRetransmits = reliability.maxRetransmits;
        }
        const channel = pc.createDataChannel(label, init);
        channel.binaryType = "arraybuffer";
        if (label === "input") {
            channel.addEventListener("open", () => {
                input = channel;
                peerOpenedAt = now();
            });
        }
        if (label === "media") {
            channel.addEventListener("message", (event: MessageEvent<ArrayBuffer | string>) => {
                const at = now();
                if (event.data instanceof ArrayBuffer) {
                    received.push([at, event.data.byteLength]);
                    const whole = join(new Uint8Array(event.data));
                    if (whole !== undefined) {
                        onBinary(whole, "peer");
                    }
                    return;
                }
                received.push([at, event.data.length]);
                onText(event.data, "peer");
            });
        }
    }
    await pc.setLocalDescription(await pc.createOffer());
    const sdp = pc.localDescription?.sdp;
    if (sdp !== undefined) {
        sendJson({ type: "rtcOffer", sdp });
    }
};

const start = async (config: DecoderConfig): Promise<void> => {
    protocol = config.protocol;
    wantPeer = config.peer === true;
    await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(config.url);
        ws.binaryType = "arraybuffer";
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", () => reject(new Error(`the stream at ${config.url} did not open`)));
        ws.addEventListener("close", (event) => {
            closed = `${event.code} ${event.reason}`.trim();
        });
        ws.addEventListener("message", (event: MessageEvent<ArrayBuffer | string>) => {
            const at = now();
            if (event.data instanceof ArrayBuffer) {
                received.push([at, event.data.byteLength]);
                onBinary(new Uint8Array(event.data));
                return;
            }
            received.push([at, event.data.length]);
            onText(event.data);
        });
        socket = ws;
    });
    if (protocol === "media") {
        // castd's liveness and round-trip probe; the editor sends one on the same beat.
        setInterval(() => sendJson({ type: "ping", t: now() }), 5000);
    }
};

// Sends one input and waits until the typing page's marker shows `expect`, or the deadline passes.
const typeOnce = async (kind: InputRecord["kind"], text: string, timeoutMs: number): Promise<void> => {
    const expect = (shownLength + text.length) % 65_536;
    const echo = new Promise<number | null>((resolve) => {
        waiter = { expect, resolve };
        setTimeout(() => resolve(null), timeoutMs);
    });
    const at = now();
    if (protocol === "legacy") {
        sendJson({ type: "text", text });
    } else if (kind === "key") {
        sendJson({ type: "key", key: text });
    } else {
        // A paste on the media wire is the clipboard set, then Ctrl+V, in that order (browser-wire's `clipboard`).
        sendJson({ type: "clipboard", content: { text } });
        sendJson({ type: "key", key: "v", ctrl: true });
    }
    const echoedAt = await echo;
    waiter = undefined;
    inputs.push({ kind, at, expect, echoedAt });
};

// Words cut to exactly `chars` characters: a paste of prose, not of one repeated key.
const pasteText = (chars: number): string => {
    const words = "the quick brown fox jumps over the lazy dog while castbench times a paste ".repeat(Math.ceil(chars / 70) + 1);
    return words.slice(0, chars);
};

const typing = async (plan: TypingPlan): Promise<void> => {
    let index = 0;
    while (now() < plan.keysUntil) {
        await typeOnce("key", "abcdefghij"[index % 10]!, 2000);
        index += 1;
        // Keystrokes a person's pace apart, jittered so they never lock to the capture's 33 ms beat.
        await sleep(150 + Math.random() * 100);
    }
    for (let paste = 0; paste < plan.pastes; paste++) {
        await typeOnce("paste", pasteText(plan.pasteChars), 5000);
        await sleep(500);
    }
};

const stop = (): DecoderLog => {
    socket?.close();
    peer?.close();
    resetDecoders();
    return { picture, markers, decoded, received, inputs, markerErrors, decodeErrors, keyframes, closed, carrier, peerOpenedAt, peerClosed };
};

// What the harness calls through page.evaluate.
export interface ViewerApi {
    readonly start: (config: DecoderConfig) => Promise<void>;
    readonly typing: (plan: TypingPlan) => Promise<void>;
    readonly firstFrame: () => boolean;
    // Which carrier the latest hello came on.
    readonly carrier: () => Carrier;
    readonly stop: () => DecoderLog;
}

declare global {
    // The viewer page's one global, set below; absent on any other page.
    var castbench: ViewerApi | undefined;
}

globalThis.castbench = { start, stop, typing, firstFrame: () => decoded.length > 0, carrier: () => carrier };
