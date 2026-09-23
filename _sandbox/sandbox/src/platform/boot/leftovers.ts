import { readFileSync } from "node:fs";
import type { ScannedProcess } from "../resources/process-scan.js";
import { parseProcStat } from "../resources/proc-stat.js";

// A leftover is a finished turn's process nobody still holds. Group membership (kernel-assigned, inherited,
// unspoofable) decides which processes are this daemon's; an env stamp then says whose conversation they belong to.
// Anything under a live tmux pane is exempt: its session retires it, not this sweep.

// `pgrp` decides ownership; `ppid` only walks upward looking for a pane.
export type SweptProcess = Pick<ScannedProcess, "pid" | "ppid" | "pgrp" | "owner">;

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
}

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

// Which of this daemon's processes nobody owns any more. Conditions are ordered so a process that is neither in-group
// nor registry-known is skipped before its stamp is read.
export const leftoverProcesses = (scanned: readonly SweptProcess[], { group, ownerLive, ownerKnown, panePids }: LeftoverPolicy): Leftover[] => {
    const parents = new Map(scanned.map((entry) => [entry.pid, entry.ppid]));
    const leftovers: Leftover[] = [];
    for (const { pid, pgrp, owner } of scanned) {
        if (owner === undefined || (pgrp !== group && !ownerKnown(owner)) || underPane(pid, parents, panePids)) {
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
