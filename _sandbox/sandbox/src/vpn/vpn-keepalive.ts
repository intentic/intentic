import { access } from "node:fs/promises";
import { errorMessage } from "@intentic/base/errors";
import type { CapabilitiesStore } from "../capabilities/capabilities-store.js";
import { tunnelEntries } from "../tunnel/tunnel-links.js";
import { vpnDrivers } from "./vpn-drivers.js";
import { connectVpn, type VpnEntry } from "./vpn-links.js";
import { upMarkerPath } from "./vpn-paths.js";

/* Keeps auto-connect VPNs up while the sandbox runs, not only at boot. A tunnel that dies mid-session (the host lost its
 * network, the gateway restarted, an IPsec SA whose single DPD re-key fell into the outage) otherwise stays down until
 * the next restart, and every private host behind it silently goes elsewhere: in eg-infra a Komodo login page lost its
 * OIDC button because 192.168.0.x fell through to the owner's home LAN.
 *
 * Redials only what the owner still wants up: auto-connect on AND its up marker still there. connectVpn writes the
 * marker on success and disconnectVpn removes it, so a tunnel taken down on purpose stays down, and one that never came
 * up is left to the boot restore and the owner. Failed redials back off, so a gateway rejecting the stored sign-in is
 * asked at most a handful of times an hour, never in a tight loop. */

const CHECK_INTERVAL_MS = 30_000;
const FIRST_RETRY_MS = 30_000;
const MAX_RETRY_MS = 10 * 60_000;

export interface VpnKeepAliveDeps {
    readonly entries: () => Promise<readonly VpnEntry[]>;
    // The owner's standing intent: the tunnel was up and nobody took it down.
    readonly marked: (entry: VpnEntry) => Promise<boolean>;
    // Down with nothing bringing it back. Up or on its way up (charon's own DPD restart, a dial from the card) is not,
    // and neither is a client not installed yet, which a redial would only answer with "rebuild first".
    readonly down: (entry: VpnEntry) => Promise<boolean>;
    readonly dial: (entry: VpnEntry) => Promise<void>;
}

export interface VpnKeepAlive {
    // One pass, as the timer runs it; a call made while a pass is in flight waits for that pass.
    readonly check: () => Promise<void>;
    readonly stop: () => void;
}

interface Backoff {
    readonly failures: number;
    readonly nextAt: number;
}

export const retryDelayMs = (failures: number): number => Math.min(FIRST_RETRY_MS * 2 ** Math.max(0, failures - 1), MAX_RETRY_MS);

export const startVpnKeepAlive = (
    deps: VpnKeepAliveDeps,
    options: {
        readonly logger: { info: (message: string) => void; warn: (message: string) => void };
        readonly checkMs?: number;
        readonly now?: () => number;
    },
): VpnKeepAlive => {
    const now = options.now ?? Date.now;
    const backoffs = new Map<string, Backoff>();
    let flight: Promise<void> | undefined;
    let stopped = false;

    const tend = async (entry: VpnEntry): Promise<void> => {
        if (entry.config.autoConnect !== "on" || !(await deps.marked(entry)) || !(await deps.down(entry))) {
            backoffs.delete(entry.id);
            return;
        }
        const held = backoffs.get(entry.id);
        if (held !== undefined && now() < held.nextAt) {
            return;
        }
        try {
            await deps.dial(entry);
            backoffs.delete(entry.id);
            options.logger.info(`vpn ${entry.id}: the tunnel had dropped, redialled it`);
        } catch (error) {
            const failures = (held?.failures ?? 0) + 1;
            const delay = retryDelayMs(failures);
            backoffs.set(entry.id, { failures, nextAt: now() + delay });
            options.logger.warn(
                `vpn ${entry.id}: the tunnel dropped and redial ${failures} failed, next try in ${Math.round(delay / 1000)}s: ${errorMessage(error)}`,
            );
        }
    };

    // One tunnel at a time, each failure its own: one that cannot be read or dialled never strands the rest.
    const pass = async (): Promise<void> => {
        const entries = await deps.entries();
        const ids = new Set(entries.map((entry) => entry.id));
        for (const id of backoffs.keys()) {
            if (!ids.has(id)) {
                backoffs.delete(id);
            }
        }
        for (const entry of entries) {
            if (stopped) {
                return;
            }
            try {
                await tend(entry);
            } catch (error) {
                options.logger.warn(`vpn ${entry.id}: its state could not be read: ${errorMessage(error)}`);
            }
        }
    };

    const guarded = async (): Promise<void> => {
        try {
            await pass();
        } catch (error) {
            options.logger.warn(`vpn: the configured tunnels could not be read: ${errorMessage(error)}`);
        } finally {
            flight = undefined;
        }
    };

    const check = (): Promise<void> => {
        flight ??= guarded();
        return flight;
    };

    const timer = setInterval(() => void check(), options.checkMs ?? CHECK_INTERVAL_MS);
    timer.unref();
    return {
        check,
        stop: () => {
            stopped = true;
            clearInterval(timer);
        },
    };
};

// The daemon's own wiring: the manifest for what exists, the driver's probe for what the OS holds, connectVpn to dial.
export const vpnKeepAliveDeps = (capabilities: Pick<CapabilitiesStore, "list">): VpnKeepAliveDeps => ({
    entries: async () => tunnelEntries(await capabilities.list(), "vpn"),
    marked: (entry) =>
        access(upMarkerPath(entry.id)).then(
            () => true,
            () => false,
        ),
    down: async (entry) => {
        const { state } = await vpnDrivers[entry.config.provider].probe(entry.id, entry.config);
        return state === "disconnected" || state === "failed";
    },
    dial: async (entry) => {
        for await (const line of connectVpn(entry)) {
            void line;
        }
    },
});
