import type { BrowserMediaClientMessage } from "@intentic/sandbox-contract/browser-wire";
import type { DecodeSeams, SocketLike } from "./decodeSeams";

// THE MEDIA SOCKET ITSELF, HELD BY THE DECODE WORKER, so a picture arriving never waits on the page's main thread. The
// page numbers each socket it dials and hears its open, its close and every JSON message, tagged with that number;
// pictures and sound stay here. The round trip is measured here too, on this thread's clock: castd echoes a ping's
// `t`, and only a `t` this side sent is believed.
//
// The socket may ride a stream of the edge's WebTransport session (mediaCarrier.ts), so a dial can take a moment to
// produce it. And while the page's peer connection carries the viewer's messages (mediaRtc.ts), what this side sends
// goes to the page for the peer instead, signalling apart, which only the socket carries.

export interface WorkerSocketIo {
    readonly text: (data: string) => void;
    readonly binary: (data: ArrayBuffer) => void;
}

export interface WorkerSocket {
    readonly dial: (socket: number, url: string, transport: boolean) => void;
    readonly hangup: (socket?: number) => void;
    readonly send: (message: BrowserMediaClientMessage) => void;
    readonly ping: () => void;
    // castd's `pong`, answering one of this side's pings.
    readonly pong: (t: number) => void;
    readonly rttMs: () => number | undefined;
    // Whether the page's peer carries the viewer's messages now.
    readonly peer: (open: boolean) => void;
}

const OPEN = 1;
// A socket that sends only pictures is alive; the page hears so at most this often rather than at every picture.
const HEARD_EVERY_MS = 1000;

type Seams = Pick<DecodeSeams, `dial` | `post` | `now`>;

// Hears `ws` for the dial `mine`, as long as it is still the current one.
const listen = (seams: Seams, io: WorkerSocketIo, ws: SocketLike, id: number, current: () => boolean, opened: () => void): void => {
    ws.binaryType = `arraybuffer`;
    let heardAt = Number.NEGATIVE_INFINITY;
    ws.addEventListener(`open`, () => {
        seams.post({ type: `open`, socket: id });
        opened();
    });
    ws.addEventListener(`close`, (event) => seams.post({ type: `close`, socket: id, code: event.code, reason: event.reason }));
    ws.addEventListener(`message`, (event) => {
        if (!current()) {
            return;
        }
        const now = seams.now();
        if (event.data instanceof ArrayBuffer) {
            io.binary(event.data);
            if (now - heardAt >= HEARD_EVERY_MS) {
                heardAt = now;
                seams.post({ type: `heard`, socket: id });
            }
        } else if (!(event.data instanceof Blob)) {
            heardAt = now;
            io.text(event.data);
            seams.post({ type: `text`, socket: id, data: event.data });
        }
    });
};

// One dial: its number, and its socket once the carrier produced one.
interface Dialled {
    readonly id: number;
    ws: SocketLike | undefined;
}

export const workerSocket = (seams: Seams, io: WorkerSocketIo): WorkerSocket => {
    let current: Dialled | undefined;
    const pings = new Set<number>();
    let rttMs: number | undefined;
    let peerOpen = false;

    const send = (message: BrowserMediaClientMessage): void => {
        if (peerOpen && !message.type.startsWith(`rtc`)) {
            seams.post({ type: `peerSend`, message });
        } else if (current?.ws !== undefined && current.ws.readyState === OPEN) {
            current.ws.send(JSON.stringify(message));
        }
    };
    const ping = (): void => {
        const t = seams.now();
        pings.add(t);
        send({ type: `ping`, t });
    };

    const hangup = (socket?: number): void => {
        if (socket !== undefined && current?.id !== socket) {
            return;
        }
        const old = current;
        current = undefined;
        old?.ws?.close();
        pings.clear();
        rttMs = undefined;
        peerOpen = false;
    };

    const dial = (id: number, url: string, transport: boolean): void => {
        hangup();
        const mine: Dialled = { id, ws: undefined };
        current = mine;
        const take = (ws: SocketLike): void => {
            if (current !== mine) {
                ws.close();
                return;
            }
            mine.ws = ws;
            listen(seams, io, ws, id, () => current === mine, ping);
        };
        const made = seams.dial(url, transport);
        if (made instanceof Promise) {
            // A carrier that could not be made at all reads as a socket that closed at once: the page's ladder redials.
            made.then(take, () => current === mine && seams.post({ type: `close`, socket: id, code: 1006, reason: `` }));
        } else {
            take(made);
        }
    };

    return {
        dial,
        hangup,
        send,
        ping,
        pong: (t) => {
            if (pings.delete(t)) {
                rttMs = seams.now() - t;
            }
        },
        rttMs: () => rttMs,
        peer: (open) => {
            peerOpen = open;
            // A round trip timed on one path says nothing of the other.
            pings.clear();
            rttMs = undefined;
        },
    };
};
