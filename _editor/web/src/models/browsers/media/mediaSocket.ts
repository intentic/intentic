import { type BrowserMediaClientMessage, MEDIA_CLOSE_CODES, MEDIA_LOSSLESS_QUERY } from "@intentic/sandbox-contract/browser-wire";
import { liveSocket, type LiveLink, type LiveSocket } from "../../../client/session/liveSocket";
import { type MediaOffer, tokenReadOnly } from "./mediaMessages";
import type { MediaWorker } from "./mediaWorker";
import type { FromWorker } from "./worker/workerWire";

// THE MEDIA SOCKET'S LIFE, ON THE PAGE: the same reconnect ladder, keepalive and silence clock as every live socket
// (liveSocket.ts), dialled by the decode worker, which holds the socket itself. Its address is the `media` message the
// window's own socket sends (`path` and a short-lived `token`), on the sandbox's own base; a fresh `media` with the same
// path and access renews the token held for the next dial and is handed to castd on the open socket (`token`), which
// castd counts the socket's life from, while a new path or another access (a desktop's read-only token swapped for a
// driving one) dials again. A token's `expiresAt` is never read against this computer's clock, which may be minutes off
// castd's: the latest token is dialled, and castd says when it will not take one. Every dial asks for an exact picture
// (MEDIA_LOSSLESS_QUERY), which castd sends only to a viewer that reaches it on this computer's loopback; the decode
// worker draws either kind of stream.

export interface MediaSocketOptions {
    readonly worker: () => MediaWorker;
    // The sandbox's base URL (ws, wss, http or https), undefined while there is no sandbox to reach.
    readonly base: () => string | undefined;
    // Asks the window's own socket for a fresh `media` (browser-wire's `{type: "media"}`).
    readonly askFresh: () => void;
    readonly onText: (data: string) => void;
    readonly onOpen: () => void;
    readonly onDrop: () => void;
    // Whether the edge in front of the sandbox declared WebTransport, so the socket may ride its session.
    readonly webTransport?: () => boolean;
}

export interface MediaSocket {
    readonly live: LiveSocket<BrowserMediaClientMessage>;
    // castd's address and token, from the window's socket.
    readonly offer: (offer: MediaOffer) => void;
    // A worker message about a socket (open, close, text, heard), routed to the dial it is about.
    readonly fromWorker: (message: FromWorker) => void;
    // Lets the socket go and forgets the offer: the window is back on its own socket's picture, or another window.
    readonly stop: () => void;
    // castd was heard some other way than the socket (its peer connection): the socket's silence clock starts over.
    readonly heard: () => void;
}

// How castd says it will not take a token. Before the upgrade it answers 401 or 403, which a browser sees only as a
// close with no open; an open socket it closes with browser-wire's MEDIA_CLOSE_CODES: `dropped` (the window's viewers
// were dropped and every token minted before with them) or `expired` (the socket's newest token lapsed long ago).
// Either way the next dial waits for a fresh token, asked of the window's socket.
const TOKEN_DEAD_CODES: ReadonlySet<number> = new Set(Object.values(MEDIA_CLOSE_CODES));
// Fresh tokens asked in a row with no socket opened since: past this the ladder dials with what is held, which the
// window's socket still renews on its own before each token lapses.
const MAX_FRESH_ASKS = 3;
// How long a dial waits for a fresh token it asked for before it dials with what it holds.
const FRESH_WAIT_MS = 10_000;

const wsBase = (base: string): string => base.replace(/^http/, `ws`).replace(/\/$/, ``);

// A fresh `media` for the socket: another path or access dials again; the same one is handed to the open socket, since
// castd keeps it open only so long past its newest token (MEDIA_TOKEN_GRACE_SECONDS).
const take = (live: LiveSocket<BrowserMediaClientMessage>, offer: MediaOffer, changed: boolean): void => {
    if (changed) {
        live.connect();
    } else if (live.isOpen()) {
        live.send({ type: `token`, token: offer.token });
    }
};

// A worker message about a socket, to the link it is about: its open, its close (a dial castd refused, or a socket it
// closed for its token, is `refused`: the next dial takes a fresh one), and anything heard on it.
const routeToLink = (
    links: Map<number, { readonly link: LiveLink; open: boolean }>,
    message: FromWorker,
    events: { readonly onText: (data: string) => void; readonly opened: () => void; readonly refused: () => void },
): void => {
    if (!(`socket` in message)) {
        return;
    }
    const entry = links.get(message.socket);
    if (entry === undefined) {
        return;
    }
    if (message.type === `open`) {
        entry.open = true;
        events.opened();
        entry.link.opened();
    } else if (message.type === `close`) {
        if (entry.link.current() && (!entry.open || TOKEN_DEAD_CODES.has(message.code))) {
            events.refused();
        }
        entry.open = false;
        links.delete(message.socket);
        entry.link.closed(message.code, message.reason);
    } else {
        entry.link.heard();
        if (message.type === `text` && entry.link.current()) {
            events.onText(message.data);
        }
    }
};

export const mediaSocket = (options: MediaSocketOptions): MediaSocket => {
    let held: MediaOffer | undefined;
    // A fresh token was asked for, since castd refused the one held: the next dial waits for it.
    let stale = false;
    let asks = 0;
    let dialled: { readonly path: string; readonly readOnly: boolean } | undefined;
    let waiting: (() => void) | undefined;
    let counter = 0;
    const links = new Map<number, { readonly link: LiveLink; open: boolean }>();

    const askFresh = (): void => {
        if (asks < MAX_FRESH_ASKS) {
            asks += 1;
            stale = true;
            options.askFresh();
        }
    };

    // The held offer, unless castd refused it and a fresh one is on its way, which is waited for.
    const usable = async (signal: AbortSignal): Promise<MediaOffer | undefined> => {
        if (held === undefined) {
            askFresh();
        }
        if (held !== undefined && !stale) {
            return held;
        }
        await new Promise<void>((resolve) => {
            const timer = window.setTimeout(resolve, FRESH_WAIT_MS);
            waiting = () => {
                window.clearTimeout(timer);
                resolve();
            };
            signal.addEventListener(`abort`, () => waiting?.(), { once: true });
        });
        waiting = undefined;
        stale = false;
        return held;
    };

    const live = liveSocket<string, BrowserMediaClientMessage>({
        mint: async (signal) => {
            const offer = await usable(signal);
            const base = options.base();
            if (offer === undefined || base === undefined) {
                return undefined;
            }
            dialled = { path: offer.path, readOnly: tokenReadOnly(offer.token) };
            return `${wsBase(base)}${offer.path}?token=${encodeURIComponent(offer.token)}&${MEDIA_LOSSLESS_QUERY}=1`;
        },
        open: (url, link) => {
            counter += 1;
            const socket = counter;
            const entry = { link, open: false };
            links.set(socket, entry);
            options.worker().post({ type: `dial`, socket, url, transport: options.webTransport?.() ?? false });
            return {
                send: (message) => options.worker().post({ type: `send`, message: message.type === `ping` ? { type: `ping`, t: 0 } : message }),
                close: () => options.worker().post({ type: `hangup`, socket }),
                ready: () => entry.open,
            };
        },
        onOpen: options.onOpen,
        onDrop: options.onDrop,
    });

    return {
        live,
        offer: (offer) => {
            const changed = dialled === undefined || dialled.path !== offer.path || dialled.readOnly !== tokenReadOnly(offer.token);
            held = offer;
            stale = false;
            waiting?.();
            take(live, offer, changed);
        },
        fromWorker: (message) => routeToLink(links, message, { onText: options.onText, opened: () => (asks = 0), refused: askFresh }),
        stop: () => {
            live.close();
            held = undefined;
            [stale, asks] = [false, 0];
            dialled = undefined;
            waiting?.();
        },
        heard: () => {
            for (const { link } of links.values()) {
                if (link.current()) {
                    link.heard();
                }
            }
        },
    };
};
