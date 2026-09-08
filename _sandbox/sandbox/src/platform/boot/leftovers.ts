import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { parseProcStat } from "../resources/proc-stat.js";

// A leftover is a finished turn's process nobody still holds. Group membership (kernel-assigned, inherited,
// unspoofable) decides which processes are this daemon's; an env stamp then says whose conversation they belong to.
// Anything under a live tmux pane is exempt: its session retires it, not this sweep.

// The stamp naming whose work a process is; identity itself is the process group, not this env var.
export const WORKLOAD_ENV = "INTENTIC_TURN_OWNER";

// Env to spread into a spawned workload's environment; owner is a conversation id or one of the two reserved names
// below.
export const workloadStamp = (owner: string): Record<string, string> => ({ [WORKLOAD_ENV]: owner });

// The two owners that are not conversations: `daemon` for pooled ACP processes kept alive across turns, and `one-shot`
// for toolless maxTurns-1 helper calls nothing will ever report live.
export const DAEMON_OWNER = "daemon";
export const ONE_SHOT_OWNER = "one-shot";

// One process as the sweep sees it; `pgrp` decides ownership, `ppid` is only used to walk upward looking for a pane.
export interface ScannedProcess {
    readonly pid: number;
    readonly ppid: number;
    readonly pgrp: number;
    readonly owner: string | undefined;
}

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
export const leftoverProcesses = (scanned: readonly ScannedProcess[], { group, ownerLive, ownerKnown, panePids }: LeftoverPolicy): Leftover[] => {
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

// Two procfs reads per process, so this runs on a minute-scale timer, not workload-priority's faster one. A pid
// vanishing between readdir and either read is normal, not an error.
const NUMERIC = /^\d+$/u;

// Reads procfs's NUL-separated environ, fixed at exec, so a process cannot rewrite the stamp it was born with.
export const ownerOf = (environ: string): string | undefined => {
    for (const entry of environ.split("\0")) {
        if (entry.startsWith(`${WORKLOAD_ENV}=`)) {
            return entry.slice(WORKLOAD_ENV.length + 1);
        }
    }
    return undefined;
};

const scanProcess = async (pid: number): Promise<ScannedProcess | undefined> => {
    try {
        const [stat, environ] = await Promise.all([readFile(`/proc/${pid}/stat`, "utf8"), readFile(`/proc/${pid}/environ`, "utf8")]);
        const ids = parseProcStat(stat);
        return ids === undefined ? undefined : { pid, ...ids, owner: ownerOf(environ) };
    } catch {
        return undefined;
    }
};

export const scanProcesses = async (): Promise<ScannedProcess[]> => {
    const entries = await readdir("/proc").catch(() => [] as string[]);
    const pids = entries.filter((entry) => NUMERIC.test(entry)).map(Number);
    const scanned = await Promise.all(pids.map((pid) => scanProcess(pid)));
    return scanned.filter((entry): entry is ScannedProcess => entry !== undefined);
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
