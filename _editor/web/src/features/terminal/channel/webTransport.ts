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
        },
        // allow(silent-catch): a session that never opened is forgotten below, when it reports closed.
        () => undefined,
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

// Test seam: what a reload forgets, every session.
export const resetTransports = (): void => {
    for (const { transport } of sessions.values()) {
        quietly(transport);
    }
    sessions.clear();
};
