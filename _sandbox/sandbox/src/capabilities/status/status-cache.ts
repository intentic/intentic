import { isDeepStrictEqual } from "node:util";
import type { CapabilityStatus } from "@intentic/sandbox-contract";

// A connection's status as its last probe found it, answered at once while the next probe runs behind it: a probe can
// be a network call, a docker exec or a model server's health check, and a list of forty waited on the slowest of them.
// A probe that finds a different answer calls `changed`, which pushes it, so a reader never holds stale words for longer
// than one probe. An edited connection is probed fresh rather than served what its old settings said.

export interface StatusCache {
    // The held status, or the first probe's when none is held; the probe behind a held answer runs at most once at a time.
    readonly status: (id: string, config: unknown, probe: () => Promise<CapabilityStatus>) => Promise<CapabilityStatus>;
    // Drops every held status whose id is not in `ids`: a removed connection's answer is never asked for again.
    readonly keepOnly: (ids: ReadonlySet<string>) => void;
}

interface Held {
    readonly config: string;
    status: CapabilityStatus;
    probing: boolean;
}

export const createStatusCache = (changed: () => void, onProbeError: (error: unknown) => void): StatusCache => {
    const held = new Map<string, Held>();
    return {
        status: async (id, config, probe) => {
            const settings = JSON.stringify(config);
            const entry = held.get(id);
            if (entry === undefined || entry.config !== settings) {
                const status = await probe();
                held.set(id, { config: settings, status, probing: false });
                return status;
            }
            if (!entry.probing) {
                entry.probing = true;
                void probe().then(
                    (status) => {
                        entry.probing = false;
                        if (!isDeepStrictEqual(status, entry.status)) {
                            entry.status = status;
                            changed();
                        }
                    },
                    (error: unknown) => {
                        entry.probing = false;
                        onProbeError(error);
                    },
                );
            }
            return entry.status;
        },
        keepOnly: (ids) => {
            for (const id of held.keys()) {
                if (!ids.has(id)) {
                    held.delete(id);
                }
            }
        },
    };
};
