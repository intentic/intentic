import { EDGE_TRANSPORTS, type EdgeTransport } from "@intentic/sandbox-contract/browser-wire";
import type { Config } from "../config.js";

// What the edge in front of every provided address declares it serves beyond HTTPS over TCP, relayed on each such
// sandbox's row (`edgeTransports`) so the editor opens WebTransport only where the edge said it may, instead of finding
// out by failing. The edge is the only source: this reads its own `/health` (`transports`, which it derives from what
// it binds), keeps the answer a minute, and reads an edge that does not answer, or answers without the field, as
// declaring nothing, which is exactly what an older edge means.

const FRESH_MS = 60_000;

// A list waits on this at most once a minute; past it the edge declares nothing until it answers.
const TIMEOUT_MS = 3_000;

// The tokens a `/health` answer declares, those this build knows, in the edge's order.
export const declaredTransports = (health: unknown): readonly EdgeTransport[] => {
    const named = typeof health === `object` && health !== null ? (health as { transports?: unknown }).transports : undefined;
    return Array.isArray(named) ? EDGE_TRANSPORTS.filter((transport) => named.includes(transport)) : [];
};

interface Reading {
    readonly url: string;
    readonly at: number;
    readonly transports: readonly EdgeTransport[];
}

type Ask = (url: string, init: RequestInit) => Promise<Response>;

export interface EdgeTransportReader {
    // The edge's declaration, asked again once the one held is a minute old; concurrent callers share one question.
    readonly read: (config: { readonly ingress: Pick<Config[`ingress`], `url`> }) => Promise<readonly EdgeTransport[]>;
    // The last declaration read, for a row shaped where nothing can wait; nothing before the first read.
    readonly held: () => readonly EdgeTransport[];
}

// One reader per process.
export const edgeTransportReader = (ask: Ask = fetch, now: () => number = Date.now): EdgeTransportReader => {
    let reading: Reading | undefined;
    let asking: Promise<readonly EdgeTransport[]> | undefined;
    const read: EdgeTransportReader[`read`] = async (config) => {
        const { url } = config.ingress;
        if (url === ``) {
            return [];
        }
        if (reading?.url === url && now() - reading.at < FRESH_MS) {
            return reading.transports;
        }
        asking ??= (async (): Promise<readonly EdgeTransport[]> => {
            try {
                const response = await ask(`${url}/health`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
                return response.ok ? declaredTransports(await response.json()) : [];
            } catch {
                // silent-catch: an edge that does not answer declares nothing, and nothing is what the row then says.
                return [];
            }
        })().then((transports) => {
            reading = { url, at: now(), transports };
            asking = undefined;
            return transports;
        });
        return asking;
    };
    return { read, held: () => reading?.transports ?? [] };
};

export const edgeTransports = edgeTransportReader();
