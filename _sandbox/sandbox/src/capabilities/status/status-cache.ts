import { isDeepStrictEqual } from "node:util";
import type { CapabilityStatus } from "@intentic/sandbox-contract/schemas/capabilities";

// A connection's status as its last probe found it, answered at once while the next probe runs behind it: a probe can
// be a network call, a docker exec or a model server's health check, and a list of forty waited on the slowest of them.
// A probe that finds a different answer calls `changed`, which pushes it. An edited connection is probed fresh rather
// than served what its old settings said.
//
// 2026-11-06: the probe behind an answer runs at most once a minute per connection, rather than behind every read. Every
// read probing every connection made a loop of itself: one changed answer pushed `capabilities`, every open window read
// the list again, and that read probed all forty again (GET /capabilities p95 13.5 s, six reads a minute per window).
// A status the contract calls `settling` (a start, a download, a code waiting to be typed) moves on its own and is still
// probed behind every read; any other one moves only by a person or by a change something announces, and such an
// announcement (`moved`) makes every held answer due at once.

// The shortest gap between two probes of one connection behind a held answer, counted from when the last one settled.
export const REPROBE_AFTER_MS = 60_000;

export interface StatusCache {
    // The held status, or the first probe's when none is held; the probe behind a held answer runs at most once at a time,
    // and only once it is due.
    readonly status: (id: string, config: unknown, probe: () => Promise<CapabilityStatus>) => Promise<CapabilityStatus>;
    // Makes one connection's held answer due, for a change this side made to it without editing its settings (a re-run
    // apply): the next read still answers at once, and probes behind it.
    readonly due: (id: string) => void;
    // Drops every held status whose id is not in `ids`: a removed connection's answer is never asked for again.
    readonly keepOnly: (ids: ReadonlySet<string>) => void;
}

export interface StatusCacheOptions {
    // A probe behind an answer found a different one.
    readonly changed: () => void;
    readonly onProbeError: (error: unknown) => void;
    // A count that moves whenever something outside the probes announces a change that can move a status (a peer
    // connecting or dropping, a sign-in saved). It must not count `changed`'s own announcements, or one changed answer
    // would make every other one due, and two flapping connections would keep each other probing.
    readonly moved?: () => number;
    readonly reprobeAfterMs?: number;
    readonly now?: () => number;
}

interface Held {
    readonly config: string;
    status: CapabilityStatus;
    probing: boolean;
    // When the last probe settled, and the `moved` count it started under.
    checkedAt: number;
    seen: number;
    // Made due by `due` since the last probe started.
    asked: boolean;
}

export const createStatusCache = ({
    changed,
    onProbeError,
    moved = () => 0,
    reprobeAfterMs = REPROBE_AFTER_MS,
    now = Date.now,
}: StatusCacheOptions): StatusCache => {
    const held = new Map<string, Held>();
    const isDue = (entry: Held): boolean =>
        entry.asked || entry.status.settling === true || entry.seen !== moved() || now() - entry.checkedAt >= reprobeAfterMs;
    return {
        status: async (id, config, probe) => {
            const settings = JSON.stringify(config);
            const entry = held.get(id);
            if (entry === undefined || entry.config !== settings) {
                const seen = moved();
                const status = await probe();
                held.set(id, { config: settings, status, probing: false, checkedAt: now(), seen, asked: false });
                return status;
            }
            if (!entry.probing && isDue(entry)) {
                entry.probing = true;
                // Taken as the probe starts: a change announced or asked for while it runs may be one it did not see.
                entry.seen = moved();
                entry.asked = false;
                void probe().then(
                    (status) => {
                        entry.probing = false;
                        entry.checkedAt = now();
                        if (!isDeepStrictEqual(status, entry.status)) {
                            entry.status = status;
                            changed();
                        }
                    },
                    (error: unknown) => {
                        entry.probing = false;
                        entry.checkedAt = now();
                        onProbeError(error);
                    },
                );
            }
            return entry.status;
        },
        due: (id) => {
            const entry = held.get(id);
            if (entry !== undefined) {
                entry.asked = true;
            }
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
