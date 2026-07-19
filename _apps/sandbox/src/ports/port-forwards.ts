import http from "node:http";
import https from "node:https";
import { PORT_SLOTS } from "@intentic/sandbox-contract";

// The forward table behind the port-<slot>-<sandboxId>.<zone> hostnames: a fixed pool of slots (PORT_SLOTS)
// mapped to whatever ports the owner currently forwards. Slots — not port numbers — appear in hostnames so the
// intentic-provided path mints at most one route per slot per sandbox lifetime while dev servers churn
// ephemeral ports; own-Cloudflare rides its wildcard either way. In-memory only: forwards are user gestures,
// and after a daemon restart a click simply re-forwards (usually landing the same, already-minted slot).

export type PortScheme = "http" | "https";

export interface PortTarget {
    readonly port: number;
    readonly scheme: PortScheme;
}

export interface PortForwards {
    // Map a port onto a slot (reusing its existing slot, else the first free one, else evicting the
    // least-recently-used) and (re)detect the upstream scheme. Returns the slot.
    readonly forward: (port: number) => Promise<string>;
    readonly unforward: (port: number) => void;
    readonly slotOf: (port: number) => string | undefined;
    // The proxy's resolver — also the LRU touch, so live preview traffic keeps its forward warm.
    readonly targetOf: (slot: string) => PortTarget | undefined;
}

// Whether `scheme` answers on the port at all (any HTTP status counts, like the panel health probe). Dev certs
// are self-signed, so TLS verification is off — the proxy talks to 127.0.0.1 inside the sandbox's own netns.
const answers = (scheme: PortScheme, port: number): Promise<boolean> =>
    new Promise((resolve) => {
        const request = (scheme === "https" ? https : http).request(
            { host: "127.0.0.1", port, method: "GET", path: "/", timeout: 1500, rejectUnauthorized: false },
            (response) => {
                response.resume();
                resolve(true);
            },
        );
        request.on("timeout", () => request.destroy());
        request.on("error", () => resolve(false));
        request.end();
    });

// A TLS upstream rejects a plaintext request at the socket and vice versa, so the two probes discriminate
// cleanly (the vite in a scaffolded app serves https on its random port). Neither answering — a server still
// booting, or WebSocket-only — defaults to http; the proxy 502s until the server responds anyway.
const detectScheme = async (port: number): Promise<PortScheme> => {
    if (await answers("http", port)) {
        return "http";
    }
    return (await answers("https", port)) ? "https" : "http";
};

export const createPortForwards = (probe: (port: number) => Promise<PortScheme> = detectScheme): PortForwards => {
    const slots = new Map<string, { port: number; scheme: PortScheme; lastUsedAt: number }>();

    const slotOf = (port: number): string | undefined => {
        for (const [slot, entry] of slots) {
            if (entry.port === port) {
                return slot;
            }
        }
        return undefined;
    };

    return {
        forward: async (port) => {
            // Allocate synchronously (before the probe awaits) so concurrent forwards of one port can't both
            // claim a slot. Re-forwarding re-probes: a dev server restarted on the same port may have flipped
            // between http and https.
            const slot =
                slotOf(port) ??
                PORT_SLOTS.find((candidate) => !slots.has(candidate)) ??
                [...slots.entries()].toSorted(([, a], [, b]) => a.lastUsedAt - b.lastUsedAt)[0]![0];
            slots.set(slot, { port, scheme: slots.get(slot)?.port === port ? slots.get(slot)!.scheme : "http", lastUsedAt: Date.now() });
            const scheme = await probe(port);
            const entry = slots.get(slot);
            // Only apply if the slot still maps this port — an eviction/re-forward may have won meanwhile.
            if (entry?.port === port) {
                slots.set(slot, { ...entry, scheme });
            }
            return slot;
        },
        unforward: (port) => {
            const slot = slotOf(port);
            if (slot !== undefined) {
                slots.delete(slot);
            }
        },
        slotOf,
        targetOf: (slot) => {
            const entry = slots.get(slot);
            if (entry === undefined) {
                return undefined;
            }
            entry.lastUsedAt = Date.now();
            return { port: entry.port, scheme: entry.scheme };
        },
    };
};
