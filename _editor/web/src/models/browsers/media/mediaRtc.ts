import { type BrowserMediaClientMessage, RTC_CHANNELS, type RtcChannelLabel } from "@intentic/sandbox-contract/browser-wire";
import { inputMessages, mediaJoiner } from "./mediaRtcWire";

// THE SHORTEST WAY TO CASTD: A PEER CONNECTION BESIDE THE MEDIA SOCKET (castd's src/rtc). A public https page cannot
// open the plain `ws://` a sandbox's LAN address would need, and no certificate names that address, so a viewer on the
// sandbox's own network reaches castd over WebRTC DataChannels instead: castd's `hello` says `rtc` when its peer port is
// published somewhere, the offer and castd's answer ride the media socket, which is already authenticated (the answer
// carries castd's DTLS fingerprint, so only this viewer can finish the handshake), and once the `media` channel opens
// castd says `hello` there and moves the stream onto the channels. The socket stays open as control and fallback: if
// ICE never connects, or the connection fails later, the peer is closed, castd is told (`rtcClose`), and castd brings
// the stream back to the socket with a `hello`. Nothing about the picture waits on any of it.
//
// The peer lives on the page: Chrome has no RTCPeerConnection in a worker, so what arrives on it is handed to the decode
// worker as the socket's own messages are, one postMessage later.

export interface ChannelLike {
    binaryType: BinaryType;
    readonly readyState: string;
    send(data: string | Uint8Array<ArrayBuffer>): void;
    close(): void;
    addEventListener(type: `open` | `close`, listener: () => void): void;
    addEventListener(type: `message`, listener: (event: { readonly data: unknown }) => void): void;
}

/** An RTCPeerConnection, as far as the media path uses one. */
export interface PeerLike {
    readonly connectionState: string;
    readonly localDescription: { readonly sdp: string } | null;
    createDataChannel(label: string, init: RTCDataChannelInit): ChannelLike;
    createOffer(): Promise<RTCSessionDescriptionInit>;
    setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
    setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
    addEventListener(type: `connectionstatechange`, listener: () => void): void;
    close(): void;
}

export interface MediaRtcOptions {
    // Says something on the media socket: the offer, and `rtcClose`.
    readonly signal: (message: BrowserMediaClientMessage) => void;
    // A message castd sent on the peer, whole: its JSON as text, a video or audio message as bytes.
    readonly arrived: (data: string | ArrayBuffer) => void;
    // Whether the viewer's own messages go on the peer's `input` channel now.
    readonly carrying: (on: boolean) => void;
    // Whether a peer could be any shorter than the way the socket already takes: false on the loopback shortcut.
    readonly wanted: () => boolean;
    // Seams for a test: the connection, and the clock its deadlines run on.
    readonly peer?: () => PeerLike | undefined;
    readonly later?: (run: () => void, ms: number) => () => void;
}

export type MediaRtcState = `off` | `connecting` | `open`;

export interface MediaRtc {
    // castd said hello, offering a peer or not.
    readonly hello: (offered: boolean) => void;
    readonly answer: (sdp: string) => void;
    // castd let go of the peer, or never took it.
    readonly closed: (reason: string) => void;
    // Sends a message on `input` when the peer carries the viewer's messages: false means the socket must take it.
    readonly send: (message: BrowserMediaClientMessage) => boolean;
    // The socket went: its peer goes with it, and the next socket may try again.
    readonly stop: () => void;
    readonly state: () => MediaRtcState;
}

// A peer that has not opened its channels by now never will on this network (castd's candidates are LAN addresses a
// viewer elsewhere cannot reach): the socket keeps the stream, and this socket does not try again.
export const OPEN_WITHIN_MS = 10_000;
// How long a connection may sit `disconnected` (consent checks unanswered) before the stream goes back to the socket.
// Chrome takes some 30 s more to call it `failed`, a stall nobody should watch.
export const DISCONNECTED_MS = 3000;

const browserPeer = (): PeerLike | undefined => (`RTCPeerConnection` in globalThis ? new RTCPeerConnection({ iceServers: [] }) : undefined);

const timeout = (run: () => void, ms: number): (() => void) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
};

const LABELS: readonly RtcChannelLabel[] = [`media`, `audio`, `input`];

// The init a channel is opened with: browser-wire's reliability for it, fully reliable where it names no maximum.
const channelInit = (label: RtcChannelLabel): RTCDataChannelInit => {
    const { ordered, maxRetransmits } = RTC_CHANNELS[label];
    const init: RTCDataChannelInit = { ordered };
    if (maxRetransmits !== null) {
        init.maxRetransmits = maxRetransmits;
    }
    return init;
};

interface ChannelEvents {
    readonly open: () => void;
    // `media` or `input` closed: the peer is no use without either; `audio` closing only silences it.
    readonly lost: () => void;
    readonly arrived: (data: string | ArrayBuffer) => void;
}

// The three channels on `peer`, castd's video joined back from its chunks before anything else sees it.
const openChannels = (peer: PeerLike, events: ChannelEvents): Map<RtcChannelLabel, ChannelLike> => {
    const channels = new Map<RtcChannelLabel, ChannelLike>();
    const join = mediaJoiner();
    for (const label of LABELS) {
        const channel = peer.createDataChannel(label, channelInit(label));
        channel.binaryType = `arraybuffer`;
        channels.set(label, channel);
        channel.addEventListener(`open`, events.open);
        channel.addEventListener(`close`, () => label !== `audio` && events.lost());
        channel.addEventListener(`message`, ({ data }) => {
            if (data instanceof ArrayBuffer) {
                const whole = label === `media` ? join(data) : data;
                if (whole !== undefined) {
                    events.arrived(whole);
                }
            } else if (label === `media`) {
                events.arrived(String(data));
            }
        });
    }
    return channels;
};

// Gives up on a connection that failed, or sat disconnected for DISCONNECTED_MS.
const watchConnection = (peer: PeerLike, giveUp: () => void, later: (run: () => void, ms: number) => () => void): void => {
    let stalled: (() => void) | undefined;
    peer.addEventListener(`connectionstatechange`, () => {
        stalled?.();
        stalled = undefined;
        if (peer.connectionState === `failed` || peer.connectionState === `closed`) {
            giveUp();
        } else if (peer.connectionState === `disconnected`) {
            stalled = later(giveUp, DISCONNECTED_MS);
        }
    });
};

// Sends `message` on an open `input`, cut to fit; false means the socket must take it (signalling always does).
const sendOnInput = (input: ChannelLike | undefined, message: BrowserMediaClientMessage): boolean => {
    if (input?.readyState !== `open` || message.type.startsWith(`rtc`)) {
        return false;
    }
    const parts = inputMessages(JSON.stringify(message));
    for (const part of parts) {
        input.send(part);
    }
    return parts.length > 0;
};

interface Held {
    readonly peer: PeerLike;
    channels: Map<RtcChannelLabel, ChannelLike>;
    readonly cancel: () => void;
}

export const mediaRtc = (options: MediaRtcOptions): MediaRtc => {
    const later = options.later ?? timeout;
    let state: MediaRtcState = `off`;
    // This socket's peer failed or was refused: it is not offered again until the socket is.
    let spent = false;
    let current: Held | undefined;

    const close = (tell: boolean): void => {
        const was = current;
        current = undefined;
        if (was === undefined) {
            return;
        }
        was.cancel();
        const carried = state === `open`;
        state = `off`;
        if (carried) {
            options.carrying(false);
        }
        try {
            was.peer.close();
        } catch {
            // allow(silent-catch): a connection that already closed is the state asked for.
        }
        if (tell) {
            options.signal({ type: `rtcClose` });
        }
    };
    const giveUp = (): void => {
        spent = true;
        close(true);
    };

    const start = async (peer: PeerLike): Promise<void> => {
        const mine: Held = { peer, channels: new Map(), cancel: later(() => current === mine && giveUp(), OPEN_WITHIN_MS) };
        current = mine;
        state = `connecting`;
        const ours = <A extends unknown[]>(run: (...args: A) => void) => (...args: A): void => {
            if (current === mine) {
                run(...args);
            }
        };
        mine.channels = openChannels(peer, {
            open: ours(() => {
                if (state === `connecting` && mine.channels.get(`media`)?.readyState === `open` && mine.channels.get(`input`)?.readyState === `open`) {
                    state = `open`;
                    mine.cancel();
                    options.carrying(true);
                }
            }),
            lost: ours(giveUp),
            arrived: ours(options.arrived),
        });
        watchConnection(peer, ours(giveUp), later);
        try {
            await peer.setLocalDescription(await peer.createOffer());
        } catch {
            // allow(silent-catch): a browser that cannot make an offer keeps the socket, which is every viewer's way in.
            ours(() => {
                spent = true;
                close(false);
            })();
            return;
        }
        const sdp = peer.localDescription?.sdp;
        if (current === mine && sdp !== undefined) {
            options.signal({ type: `rtcOffer`, sdp });
        }
    };

    return {
        hello: (offered) => {
            if (!offered || state !== `off` || spent || !options.wanted()) {
                return;
            }
            const peer = (options.peer ?? browserPeer)();
            spent = peer === undefined;
            if (peer !== undefined) {
                void start(peer);
            }
        },
        answer: (sdp) => {
            // allow(silent-catch): an answer this connection cannot take leaves it to its own deadline, which gives up.
            void current?.peer.setRemoteDescription({ type: `answer`, sdp }).catch(() => undefined);
        },
        closed: () => {
            spent = true;
            close(false);
        },
        send: (message) => state === `open` && sendOnInput(current?.channels.get(`input`), message),
        stop: () => {
            close(false);
            spent = false;
        },
        state: () => state,
    };
};
