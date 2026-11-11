import { type ActiveHost, ActiveHostSchema, type HostManager, type Takeover } from "@intentic/api-contract";
import type { Prisma } from "@intentic/prisma";
import type { AnnouncedCopy } from "../announce-copies.js";

/* WHICH COPY OF A SANDBOX RUNS IT (2026-11-11). One connect token can sit in two containers (a stale copy on the machine
 * a sandbox moved away from, the setup command pasted twice), and the edge keeps whichever dialled first, so the stale
 * one could hold the address while the real one sat refused. The row now names one active host, and every announce is
 * told whether it comes from it; a copy that is not goes on standby (the daemon's standby.ts).
 *
 * Three rules, and only these:
 *   (a) an announce while the row names no active host makes the announcing copy the active one;
 *   (b) an announce carrying a takeover (the marker `ic` writes on a move or `ic sandbox claim`) whose `at` is newer
 *       than the active host's `since` makes the announcing copy active and bumps the epoch;
 *   (c) any other announce never changes it.
 * A copy is the active one when its host label matches (case-insensitively) and, where both name one, its side (`os`)
 * does too. A copy that names no host cannot be placed, so it is told nothing and behaves as before.
 * Rejected: "the last copy to announce wins", which is exactly the fight this ends, and "the newest container wins",
 * which a stale copy restarted by its machine's keeper would win. */

export interface ActiveState {
    readonly activeHost: ActiveHost | null;
    readonly activeEpoch: number;
}

export interface ActiveDecision extends ActiveState {
    // Whether the row's active host or epoch moved, which only rules (a) and (b) do.
    readonly changed: boolean;
    // Whether the announcing copy is the active one; undefined when the platform cannot tell.
    readonly active: boolean | undefined;
}

// The column as stored, or null for a row with none or one that no longer parses.
export const activeHostOf = (stored: Prisma.JsonValue | null): ActiveHost | null => {
    const parsed = ActiveHostSchema.safeParse(stored);
    return parsed.success ? parsed.data : null;
};

const same = (left: string | undefined, right: string | undefined): boolean => left?.toLowerCase() === right?.toLowerCase();

// Whether `copy` is the copy `host` describes: the same machine name, and the same side where both say one.
export const isActiveCopy = (host: ActiveHost, copy: Pick<AnnouncedCopy, "host" | "os">): boolean =>
    copy.host !== undefined && same(host.host, copy.host) && (host.os === undefined || copy.os === undefined || same(host.os, copy.os));

const hostFor = (copy: AnnouncedCopy & { readonly host: string }, manager: HostManager | undefined, since: string, machineId?: string): ActiveHost => {
    const host: ActiveHost = { host: copy.host, manager: manager ?? `other`, since };
    if (machineId !== undefined && machineId !== ``) {
        host.machineId = machineId;
    }
    if (copy.os !== undefined) {
        host.os = copy.os;
    }
    if (copy.engine !== undefined) {
        host.env = copy.engine;
    }
    return host;
};

// The row's active host after this announce, and whether the announcing copy is it.
export const decideActive = (
    held: ActiveState,
    copy: AnnouncedCopy | undefined,
    announced: { readonly manager?: HostManager; readonly takeover?: Takeover },
    now: Date,
): ActiveDecision => {
    if (copy?.host === undefined) {
        return { ...held, changed: false, active: undefined };
    }
    const named = { ...copy, host: copy.host };
    const { takeover } = announced;
    // (b) A takeover newer than the active host's own moment moves it, the epoch with it.
    if (takeover !== undefined && (held.activeHost === null || takeover.at > Date.parse(held.activeHost.since))) {
        const activeHost = hostFor(named, announced.manager, new Date(takeover.at).toISOString(), takeover.machineId);
        return { activeHost, activeEpoch: held.activeEpoch + 1, changed: true, active: true };
    }
    // (a) Nobody holds it yet: the first copy to say where it runs does.
    if (held.activeHost === null) {
        return { activeHost: hostFor(named, announced.manager, now.toISOString()), activeEpoch: held.activeEpoch, changed: true, active: true };
    }
    // (c) Anything else is told where it stands, and moves nothing.
    return { ...held, changed: false, active: isActiveCopy(held.activeHost, named) };
};
