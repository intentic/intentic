/* oxlint-disable unicorn/require-post-message-target-origin -- a BroadcastChannel's postMessage has no target origin */
import { DEVICE_MEDIA_PATH } from "@intentic/sandbox-contract/browser-wire";
import { DemoSocket, type DemoSession } from "../transport";

/* THE DECODE WORKER'S SOCKET, ANSWERED BY THE PAGE. A media picture (a connected computer's screen) is dialled from the
   editor's decode worker (models/browsers/media/mediaWorker.ts), where the WebSocket the page's transport.ts claims is
   not the one it calls: a worker has a global of its own. So the demo starts that worker behind a small module that
   swaps the worker's WebSocket for one that hands a media path to the page over a BroadcastChannel of the worker's own,
   then loads the editor's worker exactly as it is. The page answers the path with its demo session (deviceScreen.ts),
   frame for frame, and everything after the socket (the decoder, the canvas, acks and pings) is the editor's own code. */

const DECODE_WORKER = `media-decode`;

// Between the worker's socket and the page's session: `open` and `send`/`close` from the worker, `opened`, `message` and
// `closed` back to it.
type FromSocket =
    | { readonly kind: `open`; readonly id: string; readonly url: string }
    | { readonly kind: `send`; readonly id: string; readonly data: string }
    | { readonly kind: `close`; readonly id: string };

// Run inside the worker before the editor's own module: only a media path is the page's; any other socket is a real one.
const shim = (channel: string): string => `
const channel = new BroadcastChannel(${JSON.stringify(channel)});
const Native = self.WebSocket;
const sockets = new Map();
class PageSocket extends EventTarget {
    constructor(url) {
        super();
        this.url = url;
        this.id = crypto.randomUUID();
        this.readyState = 0;
        this.binaryType = "blob";
        sockets.set(this.id, this);
        channel.postMessage({ kind: "open", id: this.id, url });
    }
    send(data) {
        if (this.readyState === 1) channel.postMessage({ kind: "send", id: this.id, data: String(data) });
    }
    close() {
        if (this.readyState >= 2) return;
        channel.postMessage({ kind: "close", id: this.id });
        this.shut(1000, "");
    }
    shut(code, reason) {
        this.readyState = 3;
        sockets.delete(this.id);
        this.dispatchEvent(Object.assign(new Event("close"), { code, reason, wasClean: code === 1000 }));
    }
}
channel.addEventListener("message", ({ data }) => {
    const socket = sockets.get(data.id);
    if (socket === undefined) return;
    if (data.kind === "opened") {
        socket.readyState = 1;
        socket.dispatchEvent(new Event("open"));
    } else if (data.kind === "message") {
        socket.dispatchEvent(new MessageEvent("message", { data: data.data }));
    } else if (data.kind === "closed") {
        socket.shut(data.code, data.reason);
    }
});
self.WebSocket = new Proxy(Native, {
    construct: (target, args) =>
        new URL(String(args[0])).pathname.startsWith(${JSON.stringify(`${DEVICE_MEDIA_PATH}/`)}) ? new PageSocket(String(args[0])) : new target(...args),
});
`;

const moduleUrl = (code: string): string => URL.createObjectURL(new Blob([code], { type: `text/javascript` }));

// The page's half: each socket the worker opens becomes a demo socket on the session its path names.
const answer = (channelName: string, session: (url: URL) => DemoSession | undefined): void => {
    const channel = new BroadcastChannel(channelName);
    const open = new Map<string, DemoSocket>();
    channel.addEventListener(`message`, ({ data }: MessageEvent<FromSocket>) => {
        if (data.kind === `send`) {
            open.get(data.id)?.send(data.data);
            return;
        }
        if (data.kind === `close`) {
            open.get(data.id)?.close();
            open.delete(data.id);
            return;
        }
        const replay = session(new URL(data.url));
        if (replay === undefined) {
            channel.postMessage({ kind: `closed`, id: data.id, code: 1006, reason: `nothing answers ${new URL(data.url).pathname} in the demo` });
            return;
        }
        const socket = new DemoSocket(data.url, replay);
        open.set(data.id, socket);
        socket.addEventListener(`open`, () => channel.postMessage({ kind: `opened`, id: data.id }));
        socket.addEventListener(`message`, (event) => {
            if (event instanceof MessageEvent) {
                channel.postMessage({ kind: `message`, id: data.id, data: event.data });
            }
        });
        socket.addEventListener(`close`, () => {
            if (open.delete(data.id)) {
                channel.postMessage({ kind: `closed`, id: data.id, code: 1000, reason: `` });
            }
        });
    });
};

/** Starts the editor's decode worker behind the shim above; every other worker as it asks. */
export const installMediaWorker = (session: (url: URL) => DemoSession | undefined): void => {
    globalThis.Worker = new Proxy(globalThis.Worker, {
        construct: (target, args: [string | URL, WorkerOptions?]) => {
            const [script, options] = args;
            if (options?.name !== DECODE_WORKER || options.type !== `module`) {
                return new target(...args);
            }
            const channel = `demo-media-${crypto.randomUUID()}`;
            answer(channel, session);
            const entry = `import ${JSON.stringify(moduleUrl(shim(channel)))};\nimport ${JSON.stringify(new URL(script, window.location.href).href)};\n`;
            return new target(moduleUrl(entry), options);
        },
    });
};
