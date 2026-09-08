import { publishRuntimeChange } from "../system/runtime-watch.js";
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
}

export interface PortForwards {
    // Maps a port to a slot (its own, else free, else LRU-evicted) and redetects the scheme; returns the slot.
    readonly forward: (port: number, host: LoopbackHost) => Promise<string>;
    readonly unforward: (port: number) => void;
    readonly slotOf: (port: number) => string | undefined;
    // The proxy's resolver; also the LRU touch that keeps live preview traffic's forward warm.
    readonly targetOf: (slot: string) => PortTarget | undefined;
}

export const createPortForwards = (
    slots: readonly string[],
    probe: (port: number, host: LoopbackHost) => Promise<PortScheme | undefined> = detectScheme,
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
            // Allocated before the probe awaits, so concurrent forwards of one port can't both claim a slot.
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
            // Published here so an eviction (freeing another port's slot) is announced by the same call that causes it.
            publishRuntimeChange("ports");
            // An unresponsive, still-booting, or WebSocket-only port forwards as http; the next forward re-probes.
            const scheme = (await probe(port, host)) ?? "http";
            const entry = assigned.get(slot);
            // Applies only if the slot still maps this port; an eviction or re-forward may have won meanwhile.
            if (entry?.port === port) {
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
