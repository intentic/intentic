import { readFileSync } from "node:fs";
import { ONE_SHOT_OWNER } from "../../seams/workload-stamp.js";
import type { ScannedProcess } from "../resources/process-scan.js";
import { parseProcStat } from "../resources/proc-stat.js";

// A leftover is a finished turn's process nobody still holds. Group membership (kernel-assigned, inherited,
// unspoofable) decides which processes are this daemon's; an env stamp then says whose conversation they belong to.
// Anything under a live tmux pane is exempt: its session retires it, not this sweep.

// `pgrp` decides ownership; `ppid` only walks upward looking for a pane, and `session` finds one the walk cannot.
// `ageMs`, how long ago it started, when the caller could tell.
export type SweptProcess = Pick<ScannedProcess, "pid" | "ppid" | "pgrp" | "owner" | "session"> & { readonly ageMs?: number };

export interface Leftover {
    readonly pid: number;
    readonly owner: string;
}

export interface LeftoverPolicy {
    // This daemon's own process group; everything it forked is in it, nothing another daemon forked can be.
    readonly group: number;
    // Whether this owner still has work in flight; injected since the turn registry holds that answer, not this module.
    readonly ownerLive: (owner: string) => boolean;
    // Licence for out-of-group survivors: reclaimable when the owner is a conversation this daemon's registry knows.
    readonly ownerKnown: (owner: string) => boolean;
    // Every live tmux pane's root pid; a stamped process descending from one is never touched here.
    readonly panePids: ReadonlySet<number>;
    // The panes of sessions nobody tagged (not one of the sandbox's own names, no owner), which a person or a program
    // made by hand: they shield a stamped process under them only while it is younger than `untaggedShieldMs`, so a
    // session nothing will ever close cannot hold a finished turn's process for the life of the sandbox (2026-10-05).
    readonly untaggedPanePids?: ReadonlySet<number>;
    readonly untaggedShieldMs?: number;
    // This daemon's own pid: a `one-shot` helper is live while its parent is, which is this daemon or another process of
    // the same helper (2026-10-05). Absent, a one-shot is judged like any owner nothing reports live.
    readonly selfPid?: number;
}

// How long a hand-made session's pane shields a stamped process under it.
export const UNTAGGED_SHIELD_MS = 24 * 3_600_000;

// Ancestry-walk cutoff: procfs should not produce a cycle this deep, but the walk must terminate regardless.
const MAX_ANCESTRY = 64;

const underPane = (pid: number, parents: ReadonlyMap<number, number>, panePids: ReadonlySet<number>): boolean => {
    let current = pid;
    for (let step = 0; step < MAX_ANCESTRY; step += 1) {
        if (panePids.has(current)) {
            return true;
        }
        const parent = parents.get(current);
        if (parent === undefined || parent === current || parent <= 1) {
            return false;
        }
        current = parent;
    }
    return false;
};

// Whether a pane holds this process: it leads the session the process keeps, or sits above it. A pane leads the session
// everything it starts keeps, so a server whose launcher exited (parented by init now, out of the walk's reach) is
// still under its pane: a background job left running for the person, say.
const heldBy = (pid: number, session: number | undefined, parents: ReadonlyMap<number, number>, panes: ReadonlySet<number>): boolean =>
    panes.size > 0 && ((session !== undefined && panes.has(session)) || underPane(pid, parents, panes));

// A one-shot helper's process is live while its parent is: the daemon that asked, or the helper process above it. One
// whose parent died was reparented to init or a subreaper, which is neither.
const oneShotParented = (pid: number, scanned: ReadonlyMap<number, SweptProcess>, selfPid: number): boolean => {
    const parent = scanned.get(pid)?.ppid;
    return parent !== undefined && (parent === selfPid || scanned.get(parent)?.owner === ONE_SHOT_OWNER);
};

// Which of this daemon's processes nobody owns any more. Conditions are ordered so a process that is neither in-group
// nor registry-known is skipped before its stamp is read.
export const leftoverProcesses = (scanned: readonly SweptProcess[], policy: LeftoverPolicy): Leftover[] => {
    const { group, ownerLive, ownerKnown, panePids } = policy;
    const untagged = policy.untaggedPanePids ?? new Set<number>();
    const shieldMs = policy.untaggedShieldMs ?? UNTAGGED_SHIELD_MS;
    const parents = new Map(scanned.map((entry) => [entry.pid, entry.ppid]));
    const byPid = new Map(scanned.map((entry) => [entry.pid, entry]));
    const leftovers: Leftover[] = [];
    for (const { pid, pgrp, owner, session, ageMs } of scanned) {
        if (owner === undefined || (pgrp !== group && !ownerKnown(owner)) || heldBy(pid, session, parents, panePids)) {
            continue;
        }
        // An age nobody could read is young: the shield stays up rather than come down on a guess.
        if (heldBy(pid, session, parents, untagged) && (ageMs === undefined || ageMs < shieldMs)) {
            continue;
        }
        if (owner === ONE_SHOT_OWNER && policy.selfPid !== undefined && oneShotParented(pid, byPid, policy.selfPid)) {
            continue;
        }
        if (!ownerLive(owner)) {
            leftovers.push({ pid, owner });
        }
    }
    return leftovers;
};

// SIGTERM first and SIGKILL only once already asked; `asked` remembers which pids already got the first signal.
export const signalFor = (pid: number, asked: ReadonlySet<number>): NodeJS.Signals => (asked.has(pid) ? "SIGKILL" : "SIGTERM");

// This daemon's own process group, read once from procfs. Undefined off Linux or when procfs won't answer; the sweep
// then does nothing, since it cannot tell its own processes from anyone else's.
export const ownProcessGroup = (): number | undefined => {
    try {
        return parseProcStat(readFileSync("/proc/self/stat", "utf8"))?.pgrp;
    } catch {
        return undefined;
    }
};
