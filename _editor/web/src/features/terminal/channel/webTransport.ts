import { sleep } from "@intentic/base/async";
import { WEBTRANSPORT_PATH } from "@intentic/sandbox-contract/terminal-frames";
import { storeValue, storedValue } from "../../../lib/browserStorage";

// One WebTransport session per sandbox origin, which the edge answers and whose streams never queue behind each other.
// Only a session already ready on this connection is reused. Handshakes run beside the WebSocket opened now,
// so changing to a network that carries no UDP never delays a terminal.

// A QUIC handshake is one round trip; past this the network is not carrying it.
const READY_WITHIN_MS = 1500;
const REFUSED_FOR_MS = 10 * 60_000;
const OUTCOME_KEY = `intentic.webTransport.`;
const OK = `ok`;

interface Opening {
    readonly transport: WebTransport;
    ready: boolean;
}

const opening = new Map<string, Opening>();
// Per origin: `ok` once a session opened there, else the epoch milliseconds one last failed; this page's own word, which
// storage carries to the next.
const outcomes = new Map<string, string>();

const outcomeOf = (origin: string): string | undefined => outcomes.get(origin) ?? storedValue(`${OUTCOME_KEY}${origin}`);

const remember = (origin: string, outcome: string): void => {
    outcomes.set(origin, outcome);
    storeValue(`${OUTCOME_KEY}${origin}`, outcome);
};

const quietly = (transport: WebTransport): void => {
    try {
        transport.close();
    } catch {
        // silent-catch: closing a session that already closed throws, and closed is what was asked.
    }
};

// Drops `transport` as `origin`'s session, so the next stream asks for another rather than failing on this one.
export const forgetTransport = (origin: string, transport: WebTransport): void => {
    if (opening.get(origin)?.transport === transport) {
        opening.delete(origin);
    }
    quietly(transport);
};

// Sends `origin` to WebSockets for a while: its session never opened, or what answered a stream was not a terminal.
export const refuseTransport = (origin: string, transport: WebTransport, now = Date.now()): void => {
    remember(origin, String(now));
    forgetTransport(origin, transport);
};

const open = (origin: string): Opening => {
    const transport = new WebTransport(`${origin}${WEBTRANSPORT_PATH}`);
    const held: Opening = { transport, ready: false };
    opening.set(origin, held);
    void Promise.race([
        transport.ready.then(
            () => true,
            () => false,
        ),
        sleep(READY_WITHIN_MS).then(() => false),
    ]).then((opened) => {
        if (opening.get(origin) !== held) {
            return;
        }
        if (opened) {
            held.ready = true;
            remember(origin, OK);
        } else {
            refuseTransport(origin, transport);
        }
    });
    void transport.closed
        // silent-catch: however the session ended, clean or not, its holder forgets it the same way.
        .catch(() => undefined)
        .then(() => {
            if (opening.get(origin) === held) {
                opening.delete(origin);
            }
        });
    return held;
};

// The session for `base`'s origin, or undefined, which means a WebSocket now: none can be had, or none has proven itself.
export const transportFor = async (base: string, now = Date.now()): Promise<WebTransport | undefined> => {
    if (globalThis.WebTransport === undefined || !base.startsWith(`https://`)) {
        return undefined;
    }
    const origin = new URL(base).origin;
    const outcome = outcomeOf(origin);
    if (outcome !== undefined && outcome !== OK && now - Number(outcome) < REFUSED_FOR_MS) {
        return undefined;
    }
    const held = opening.get(origin) ?? open(origin);
    return held.ready ? held.transport : undefined;
};

// Test seam: what a reload forgets, every session and this page's outcomes; what storage kept stays.
export const resetTransports = (): void => {
    for (const { transport } of opening.values()) {
        quietly(transport);
    }
    opening.clear();
    outcomes.clear();
};
