import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { parseProcStat } from "./proc-stat.js";

/* LEFTOVERS, everything a turn started, reclaimed once nobody owns it any more.
 *
 * A turn is a tree of processes, and only the root of it is ours. The provider CLI is a child of the daemon; its
 * MCP servers are children of the CLI; the headless Chromium those launch is a child again. Nothing in that tree
 * below the root has a handle anyone here holds, so every way a turn can end badly, the CLI killed mid-stream, a
 * stopped turn whose unwind didn't reach the grandchildren, the daemon itself replaced by an update, leaves the
 * bottom of the tree running. Reparented to init, holding a browser profile and a few hundred MB, waiting for a
 * request that will never come. They accumulate: a sandbox observed mid-investigation carried twelve of them, the
 * oldest 37 minutes into an afterlife nobody had asked for.
 *
 * THE MECHANISM IS INHERITANCE, twice over, for the reason workload-priority.ts reaches for niceness: what a
 * subtree carries without anyone propagating it is the only thing that describes a tree nobody holds a handle on.
 *
 * WHICH TREE IS MINE is the PROCESS GROUP, and it is the kernel's answer rather than ours. Every process the
 * daemon forks inherits its group, keeps it when its parent dies and it is reparented to init, and, this is the
 * whole point, cannot be confused with another daemon's, because a group is named after the process that leads
 * it. A second daemon in this container is in the group of whatever started it (an agent's shell, its own tmux
 * pane) and its group is not this one. It therefore cannot SEE this daemon's processes to get them wrong.
 *
 * That is not a refinement of the label this module used to key on; it is the repair of it. A boot id in an env
 * var is a claim about identity that anything can read and any older copy of this file can misread, and every
 * agent branch in this workspace holds such a copy, because this repository IS the daemon and running it from
 * source is how you watch a change work. Twice on 2026-08-11 a source run's first sweep read the live daemon's
 * processes as a dead life's leavings and killed them mid-turn, four agent turns at a time. No liveness check
 * fixes that class, because the check has to be in the code doing the killing. Group membership does: a sweep
 * enumerates its own group and never learns the others exist.
 *
 * WHOSE WORK IT IS stays an env stamp, because that answer has no kernel object, a conversation id is ours. It
 * is read only for processes already proven to be in this daemon's group, so it decides WHICH of my processes to
 * reclaim and never WHOSE they are.
 *
 * WHOSE IT IS, is a conversation. Its turn run is live or it is not (turn-runs.ts), and that is the same fact the
 * chat, the fleet card and the journal all key on, so a leftover here is exactly "a process belonging to a turn
 * that has finished", with no fourth definition of alive to keep true. One-shots (the title namer and its kind)
 * name a conversation nothing will ever report live, which is honest: bounded to maxTurns 1 and toolless, one that
 * outlives its grace window is broken by construction.
 *
 * A DAEMON'S DEATH is survivable without a word about lives or generations. The container hands its daemon the
 * same pid every restart, so a successor leads the same group its predecessor did and simply inherits the
 * orphans: they are processes in my group whose owner is not live, which is the ordinary rule below.
 *
 * WHAT IS DELIBERATELY EXEMPT is anything under a LIVE tmux pane. A pane is a place with a watcher: the user has
 * a tab on it, the terminals list shows it, and the reaper (platform/reaper.ts) retires the SESSION as a unit
 * once its conversation has stopped, killing a pane's tree out from under a session that is about to die whole
 * would only race that. A backgrounded child process inherits its parent turn's stamp and can legitimately run on
 * briefly past the turn that started it, with the owner reading along. Ancestry is walked rather than matched on
 * the pane's own pid, because the thing actually holding the memory is several forks below the shell.
 *
 * And the sweep only ever touches what carries OUR stamp. A sandbox is a machine people run their own daemons on;
 * a rule phrased as "orphaned processes" would eventually meet somebody's deliberate `nohup … &` and be right
 * about the parent and wrong about everything else. */

/* The stamp: WHOSE work this is, and nothing else. No boot id in it any more, identity of the daemon is the
 * process group, and putting it here as well would be a second answer to a question the kernel already answers.
 *
 * The name changed with the meaning, which has a useful side effect: an older sweep looks for a variable that is
 * no longer set on anything, and unstamped is the case every version of this file has always handled correctly,
 * a sandbox is somebody's machine too, and a rule phrased as "orphaned processes" would eventually meet
 * somebody's deliberate `nohup … &`. Every stale checkout in this workspace is therefore blind to us rather than
 * wrong about us, without one of them being edited. */
export const WORKLOAD_ENV = "INTENTIC_TURN_OWNER";

// The env a spawned workload gets, to be spread into the child's environment. Owner is the conversation the work
// belongs to; a flow with no conversation of its own passes one of the two reserved names below.
export const workloadStamp = (owner: string): Record<string, string> => ({ [WORKLOAD_ENV]: owner });

/* THE TWO OWNERS THAT ARE NOT CONVERSATIONS.
 *
 * `daemon` is for what the daemon keeps across turns on purpose, the pooled ACP agent processes. It is always
 * live in this life, so the in-life sweep never touches one; what the stamp buys is the OTHER half, since a pool
 * process from a previous daemon is indistinguishable from a live one by any other means and nothing adopts it.
 *
 * `one-shot` is the helper calls (agent/one-shot.ts): toolless, maxTurns 1, and unwilling to wait even fifteen
 * seconds on a retry because "the answer is worthless by the time it arrives". Nothing will ever report it live,
 * which is the honest answer, there is no run to ask about, and one still breathing a grace window later has
 * outlived every purpose it had. These are the ones actually caught in the wild: a dozen of them at a time,
 * reparented to init, the oldest 37 minutes old. */
export const DAEMON_OWNER = "daemon";
export const ONE_SHOT_OWNER = "one-shot";

// One process as the sweep needs to see it. `pgrp` is what makes it mine or not; `ppid` is only ever used to
// walk upward looking for a pane.
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
    // This daemon's process group, the whole of what it may act on. Everything it forked is in here; nothing
    // another daemon forked can be.
    readonly group: number;
    // Whether this owner still has work in flight. Injected because the answer lives in the turn registry, and
    // this module deliberately knows nothing about turns.
    readonly ownerLive: (owner: string) => boolean;
    /* The SECOND licence, for what the group cannot see: a pane's processes are forked by the tmux server (their
     * group is the pane's, never this daemon's), so a `setsid`/`nohup` survivor of a killed agent session would
     * be stamped, orphaned, and permanently out of reach of a group-keyed sweep. A stamped process OUTSIDE the
     * group may be reclaimed exactly when its owner is a conversation THIS daemon's registry knows: another
     * daemon's conversations are not in it, and the two reserved owners (daemon/one-shot) deliberately fail it,
     * so the group rule still decides for everything the daemon forked itself. */
    readonly ownerKnown: (owner: string) => boolean;
    // Every live tmux pane's root pid. A stamped process descending from one of these is somebody's visible
    // work and is never touched here, the pane's SESSION is the unit that dies (platform/reaper.ts), and
    // whatever survives that death is caught by the ownerKnown licence above on a later pass.
    readonly panePids: ReadonlySet<number>;
}

// A tree this deep is a cycle procfs should not be able to show us, but the walk runs over numbers read from
// disk and must terminate on any of them.
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

/* The pure decision: which of MY processes nobody owns any more. The conditions are ordered so the dangerous
 * one stays unreachable, neither in my group nor mine by registry is not my business, whatever it is stamped
 * with. No clock: the grace window belongs to the sweep, which is the only thing that can say how long a pid
 * has been in this state. */
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

/* THE SCAN. Two small procfs reads per process, which is why this runs on a minute-scale timer and not the
 * 250ms one workload-priority affords: `environ` is a copy of the child's whole environment block and there are a
 * couple of hundred processes in a busy sandbox.
 *
 * A pid that vanishes between readdir and either read is the normal case, not an error, the sweep is looking at
 * a moving system and simply does not see that one this pass. */
const NUMERIC = /^\d+$/u;

// procfs hands back the environment NUL-separated, in the form it had at exec, which is what we want: a child
// cannot edit its way out of the stamp it was born with.
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

// SIGTERM first and SIGKILL only on the pass after, so a process with a shutdown path gets to run it. The two
// signals are a window apart by construction: `asked` remembers what has already been asked nicely.
export const signalFor = (pid: number, asked: ReadonlySet<number>): NodeJS.Signals => (asked.has(pid) ? "SIGKILL" : "SIGTERM");

/* THIS DAEMON'S GROUP, read once from procfs, the group half of the sweep's licence, and the reason it cannot
 * reach another daemon's work. Undefined off Linux and on any procfs that will not answer, and the sweep then
 * does nothing at all: a daemon that cannot establish which processes are its own has no business signalling
 * any of them. */
export const ownProcessGroup = (): number | undefined => {
    try {
        return parseProcStat(readFileSync("/proc/self/stat", "utf8"))?.pgrp;
    } catch {
        return undefined;
    }
};
