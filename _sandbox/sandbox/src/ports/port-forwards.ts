import { opt } from "../opt.js";
import { publishRuntimeChange } from "../seams/runtime-feed.js";
import { detectScheme, type PortScheme } from "./port-probe.js";
import type { LoopbackHost } from "./port-scan.js";

// Forward table behind port-<slot>-<sandboxId>.<zone> hostnames: fixed slots mapped to whatever ports the owner
// forwards, so a route stays stable per slot while dev-server ports churn. In-memory only; a restart just re-forwards.
// Slot names are injected here, derived from the connect token.

export interface PortTarget {
    readonly port: number;
    // Loopback address the listener actually dials at; a `localhost` bind can be ::1-only (Vite).
    readonly host: LoopbackHost;
    readonly scheme: PortScheme;
    // The runner whose own loopback port this is (2026-11-23): netd carries the preview down that runner's uplink
    // (PreviewRoute `runner`), and the runner's netd dials `localhost:<port>` there. Absent: a port of this sandbox.
    readonly runner?: string;
}

export interface PortForwards {
    // Maps a port to a slot (its own, else free, else LRU-evicted) and redetects the scheme; returns the slot.
    readonly forward: (port: number, host: LoopbackHost) => Promise<string>;
    readonly unforward: (port: number) => void;
    readonly slotOf: (port: number) => string | undefined;
    // A port on one of this sandbox's runners onto a slot of the same table and grammar (its own, else free, else
    // LRU-evicted), so its address is `port-<slot>-<sandboxId>` like any forward; returns the slot. Nothing is probed:
    // the port is the runner's, and its netd dials it as http.
    readonly forwardRunner: (runner: string, port: number) => string;
    readonly unforwardRunner: (runner: string, port: number) => void;
    readonly slotOfRunner: (runner: string, port: number) => string | undefined;
    // The proxy's resolver; also the LRU touch that keeps live preview traffic's forward warm.
    readonly targetOf: (slot: string) => PortTarget | undefined;
}

export const createPortForwards = (
    slots: readonly string[],
    probe: (port: number, host: LoopbackHost) => Promise<PortScheme | undefined> = detectScheme,
): PortForwards => {
    const assigned = new Map<string, { port: number; host: LoopbackHost; scheme: PortScheme; lastUsedAt: number; runner?: string }>();

    // A runner's port and this sandbox's port of the same number are different forwards.
    const slotOfOn = (runner: string | undefined, port: number): string | undefined => {
        for (const [slot, entry] of assigned) {
            if (entry.port === port && entry.runner === runner) {
                return slot;
            }
        }
        return undefined;
    };
    const slotOf = (port: number): string | undefined => slotOfOn(undefined, port);
    // Its own slot, else a free one, else the least recently used.
    const claim = (own: string | undefined): string =>
        own ??
        slots.find((candidate) => !assigned.has(candidate)) ??
        [...assigned.entries()].toSorted(([, a], [, b]) => a.lastUsedAt - b.lastUsedAt)[0]![0];

    return {
        forward: async (port, host) => {
            // Allocated before the probe awaits, so concurrent forwards of one port can't both claim a slot.
            const slot = claim(slotOf(port));
            const held = assigned.get(slot);
            assigned.set(slot, {
                port,
                host,
                scheme: held?.port === port && held.runner === undefined ? held.scheme : "http",
                lastUsedAt: Date.now(),
            });
            // Published here so an eviction (freeing another port's slot) is announced by the same call that causes it.
            publishRuntimeChange("ports");
            // An unresponsive, still-booting, or WebSocket-only port forwards as http; the next forward re-probes.
            const scheme = (await probe(port, host)) ?? "http";
            const entry = assigned.get(slot);
            // Applies only if the slot still maps this port; an eviction or re-forward may have won meanwhile.
            if (entry?.port === port && entry.runner === undefined) {
                assigned.set(slot, { ...entry, scheme });
            }
            return slot;
        },
        unforward: (port) => {
            const slot = slotOf(port);
            if (slot !== undefined) {
                assigned.delete(slot);
                publishRuntimeChange("ports");
            }
        },
        slotOf,
        forwardRunner: (runner, port) => {
            const slot = claim(slotOfOn(runner, port));
            assigned.set(slot, { port, host: "127.0.0.1", scheme: "http", lastUsedAt: Date.now(), runner });
            publishRuntimeChange("ports");
            return slot;
        },
        unforwardRunner: (runner, port) => {
            const slot = slotOfOn(runner, port);
            if (slot !== undefined) {
                assigned.delete(slot);
                publishRuntimeChange("ports");
            }
        },
        slotOfRunner: slotOfOn,
        targetOf: (slot) => {
            const entry = assigned.get(slot);
            if (entry === undefined) {
                return undefined;
            }
            entry.lastUsedAt = Date.now();
            return { port: entry.port, host: entry.host, scheme: entry.scheme, ...opt("runner", entry.runner) };
        },
    };
};
