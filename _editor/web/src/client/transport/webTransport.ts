import { WEBTRANSPORT_PATH } from "@intentic/sandbox-contract/browser-wire";

// One WebTransport session per sandbox origin, opened only where the edge DECLARED it serves one (the sandbox row's
// `edgeTransports`, which the platform reads off the edge's own /health), and used only once it is ready: until then,
// and whenever it fails or closes, a terminal takes a WebSocket, so a network that carries no UDP never delays one.
// Nothing about a failure is remembered: a session that closes is forgotten, and the next connect asks again, off the
// terminal's path, on the channel's own backoff.

interface Held {
    readonly transport: WebTransport;
    ready: boolean;
}

const sessions = new Map<string, Held>();
// Origins whose last session never opened (UDP blocked, an edge that stopped serving it): `readyTransport` does not wait
// on them again. A session that opens forgets the mark.
const unopened = new Set<string>();

const quietly = (transport: WebTransport): void => {
    try {
        transport.close();
    } catch {
        // allow(silent-catch): closing a session that already closed throws, and closed is what was asked.
    }
};

const open = (origin: string): Held => {
    const transport = new WebTransport(`${origin}${WEBTRANSPORT_PATH}`);
    const held: Held = { transport, ready: false };
    sessions.set(origin, held);
    transport.ready.then(
        () => {
            held.ready = true;
            unopened.delete(origin);
        },
        // A session that never opened is forgotten below, when it reports closed.
        () => unopened.add(origin),
    );
    void transport.closed
        // allow(silent-catch): however the session ended, clean or not, its holder forgets it the same way.
        .catch(() => undefined)
        .then(() => {
            if (sessions.get(origin) === held) {
                sessions.delete(origin);
            }
        });
    return held;
};

// The ready session for `base`'s origin, or undefined, which means a WebSocket now: the edge declared none, this browser
// has none, or the one asked for has not opened yet.
export const transportFor = (base: string, declared: boolean): WebTransport | undefined => {
    if (!declared || globalThis.WebTransport === undefined || !base.startsWith(`https://`)) {
        return undefined;
    }
    const origin = new URL(base).origin;
    const held = sessions.get(origin) ?? open(origin);
    return held.ready ? held.transport : undefined;
};

// The ready session for `base`'s origin, waiting at most `graceMs` for one still opening; undefined means a WebSocket.
// For a socket dialled once and kept (the browser's media socket, mediaCarrier.ts), where the carrier its first dial
// takes is the one it keeps. An origin whose last session never opened is not waited on, so a network with no UDP pays
// the grace once.
export const readyTransport = async (base: string, declared: boolean, graceMs: number): Promise<WebTransport | undefined> => {
    const now = transportFor(base, declared);
    if (now !== undefined || !declared || globalThis.WebTransport === undefined || !base.startsWith(`https://`)) {
        return now;
    }
    const origin = new URL(base).origin;
    const held = sessions.get(origin);
    if (held === undefined || unopened.has(origin)) {
        return undefined;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const graceOver = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, graceMs);
    });
    // allow(silent-catch): a session that fails to open is a WebSocket, said by `held.ready` staying false.
    await Promise.race([held.transport.ready.catch(() => undefined), graceOver]);
    clearTimeout(timer);
    return held.ready ? held.transport : undefined;
};

// Test seam: what a reload forgets, every session.
export const resetTransports = (): void => {
    for (const { transport } of sessions.values()) {
        quietly(transport);
    }
    sessions.clear();
    unopened.clear();
};
