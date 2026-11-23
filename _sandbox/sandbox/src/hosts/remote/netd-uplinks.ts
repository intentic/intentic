import type { FromNode } from "@intentic/sandbox-contract/netd-wire";
import type { DeviceUplinksReport } from "../../netd/netd-link.js";

/* The daemon's half of the computers' uplinks netd holds (netd's uplinks.rs): what netd last reported of each, and the
   registrations sent to it. netd keeps a registration across a daemon restart, so this starts knowing nothing and learns
   the whole of it from netd's first report after the hello; and a netd older than device uplinks never reports, so a
   registration is sent only once one has arrived (an older netd closes the link on a frame kind it does not know). */

export interface NetdUplinks {
    // Whether this netd carries device uplinks: it has reported at least once.
    readonly supported: () => boolean;
    // Whether the uplink of `device` (its uplink id) is up.
    readonly connected: (device: string) => boolean;
    // Every device netd holds a registration for, as it last reported.
    readonly registered: () => readonly string[];
    // Lets `device`'s remoted dial with the token whose SHA-256 is `digest`; the same digest again sends nothing.
    readonly register: (device: string, digest: string) => void;
    readonly withdraw: (device: string) => void;
    // True once `device`'s uplink is up, at once if it is; false after `timeoutMs`.
    readonly whenConnected: (device: string, timeoutMs: number) => Promise<boolean>;
    // netd's report, from the link (netd-door.ts).
    readonly heard: (report: DeviceUplinksReport) => void;
    // Called after each report, with the devices netd named: how the remote access reconciles what an earlier daemon
    // left registered.
    readonly onReport: (listener: (devices: readonly string[]) => void) => () => void;
}

export const netdUplinks = (tell: (message: FromNode) => void): NetdUplinks => {
    let known: Map<string, boolean> | undefined;
    // The digest last sent per device, so a repeat sends nothing; forgotten on a withdrawal.
    const sent = new Map<string, string>();
    const waiting = new Set<() => void>();
    const listeners = new Set<(devices: readonly string[]) => void>();
    return {
        supported: () => known !== undefined,
        connected: (device) => known?.get(device) === true,
        registered: () => [...(known?.keys() ?? [])],
        register: (device, digest) => {
            if (known === undefined || (sent.get(device) === digest && known.has(device))) {
                return;
            }
            sent.set(device, digest);
            tell({ kind: "deviceUplink", device, tokenSha256: digest });
        },
        withdraw: (device) => {
            sent.delete(device);
            if (known !== undefined) {
                tell({ kind: "deviceWithdraw", device });
            }
        },
        whenConnected: (device, timeoutMs) =>
            new Promise((resolve) => {
                if (known?.get(device) === true) {
                    resolve(true);
                    return;
                }
                const check = (): void => {
                    if (known?.get(device) === true) {
                        clearTimeout(timer);
                        waiting.delete(check);
                        resolve(true);
                    }
                };
                const timer = setTimeout(() => {
                    waiting.delete(check);
                    resolve(false);
                }, timeoutMs);
                timer.unref?.();
                waiting.add(check);
            }),
        heard: (report) => {
            known = new Map(report.uplinks.map((uplink) => [uplink.device, uplink.connected]));
            // A check that resolves deletes itself, which a Set's own iteration allows.
            for (const check of waiting) {
                check();
            }
            const devices = [...known.keys()];
            for (const listener of listeners) {
                listener(devices);
            }
        },
        onReport: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
};
