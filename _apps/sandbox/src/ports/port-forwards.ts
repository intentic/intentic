import http from "node:http";
import https from "node:https";
import type { LoopbackHost } from "./port-scan.js";

// The forward table behind the port-<slot>-<sandboxId>.<zone> hostnames: a fixed pool of slots mapped to
// whatever ports the owner currently forwards. Slots — not port numbers — appear in hostnames so the
// intentic-provided path mints at most one route per slot per sandbox lifetime while dev servers churn
// ephemeral ports; own-Cloudflare rides its wildcard either way. In-memory only: forwards are user gestures,
// and after a daemon restart a click simply re-forwards (usually landing the same, already-minted slot).
//
// The slot NAMES are injected rather than imported: they are derived from the connect token
// (portSlotsFromToken), so this table has no opinion about them beyond their count and their order.

export type PortScheme = "http" | "https";

export interface PortTarget {
    readonly port: number;
    // The loopback address the listener is actually dialable at (a `localhost` bind can be ::1-only — Vite).
    readonly host: LoopbackHost;
    readonly scheme: PortScheme;
}

export interface PortForwards {
    // Map a port onto a slot (reusing its existing slot, else the first free one, else evicting the
    // least-recently-used) and (re)detect the upstream scheme at the listener's dial host. Returns the slot.
    readonly forward: (port: number, host: LoopbackHost) => Promise<string>;
    readonly unforward: (port: number) => void;
    readonly slotOf: (port: number) => string | undefined;
    // The proxy's resolver — also the LRU touch, so live preview traffic keeps its forward warm.
    readonly targetOf: (slot: string) => PortTarget | undefined;
}

// Whether `scheme` answers on the port at all (any HTTP status counts, like the panel health probe). Dev certs
// are self-signed, so TLS verification is off — the dial never leaves the sandbox's own netns.
const answers = (scheme: PortScheme, port: number, host: LoopbackHost): Promise<boolean> =>
    new Promise((resolve) => {
        const request = (scheme === "https" ? https : http).request(
            { host, port, method: "GET", path: "/", timeout: 1500, rejectUnauthorized: false },
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
const detectScheme = async (port: number, host: LoopbackHost): Promise<PortScheme> => {
    if (await answers("http", port, host)) {
        return "http";
    }
    return (await answers("https", port, host)) ? "https" : "http";
};

export const createPortForwards = (
    slots: readonly string[],
    probe: (port: number, host: LoopbackHost) => Promise<PortScheme> = detectScheme,
): PortForwards => {
    const assigned = new Map<string, { port: number; host: LoopbackHost; scheme: PortScheme; lastUsedAt: number }>();

    const slotOf = (port: number): string | undefined => {
        for (const [slot, entry] of assigned) {
            if (entry.port === port) {
                return slot;
            }
        }
        return undefined;
    };

    return {
        forward: async (port, host) => {
            // Allocate synchronously (before the probe awaits) so concurrent forwards of one port can't both
            // claim a slot. Re-forwarding re-probes: a dev server restarted on the same port may have flipped
            // between http and https (or moved loopback families).
            const slot =
                slotOf(port) ??
                slots.find((candidate) => !assigned.has(candidate)) ??
                [...assigned.entries()].toSorted(([, a], [, b]) => a.lastUsedAt - b.lastUsedAt)[0]![0];
            assigned.set(slot, {
                port,
                host,
                scheme: assigned.get(slot)?.port === port ? assigned.get(slot)!.scheme : "http",
                lastUsedAt: Date.now(),
            });
            const scheme = await probe(port, host);
            const entry = assigned.get(slot);
            // Only apply if the slot still maps this port — an eviction/re-forward may have won meanwhile.
            if (entry?.port === port) {
                assigned.set(slot, { ...entry, scheme });
            }
            return slot;
        },
        unforward: (port) => {
            const slot = slotOf(port);
            if (slot !== undefined) {
                assigned.delete(slot);
            }
        },
        slotOf,
        targetOf: (slot) => {
            const entry = assigned.get(slot);
            if (entry === undefined) {
                return undefined;
            }
            entry.lastUsedAt = Date.now();
            return { port: entry.port, host: entry.host, scheme: entry.scheme };
        },
    };
};
