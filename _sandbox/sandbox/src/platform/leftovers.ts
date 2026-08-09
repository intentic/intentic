import { readdir, readFile } from "node:fs/promises";
import type { Logger } from "pino";

/* LEFTOVERS — everything a turn started, reclaimed once nobody owns it any more.
 *
 * A turn is a tree of processes, and only the root of it is ours. The provider CLI is a child of the daemon; its
 * MCP servers are children of the CLI; the headless Chromium those launch is a child again. Nothing in that tree
 * below the root has a handle anyone here holds, so every way a turn can end badly — the CLI killed mid-stream, a
 * stopped turn whose unwind didn't reach the grandchildren, the daemon itself replaced by an update — leaves the
 * bottom of the tree running. Reparented to init, holding a browser profile and a few hundred MB, waiting for a
 * request that will never come. They accumulate: a sandbox observed mid-investigation carried twelve of them, the
 * oldest 37 minutes into an afterlife nobody had asked for.
 *
 * THE MECHANISM IS THE ENVIRONMENT, for the reason workload-priority.ts reaches for niceness: it is the one
 * property a subtree inherits without anyone propagating it. Stamp the provider CLI with who it is working for
 * and every descendant carries the same answer, however many levels down and whoever spawned it — @playwright/mcp
 * did not have to cooperate, and neither did Chromium. procfs hands it back for any pid, so the whole tree is
 * legible from outside with no registry to keep in sync and nothing to leak when the daemon dies.
 *
 * WHOSE IT IS, is a conversation. Its turn run is live or it is not (turn-runs.ts), and that is the same fact the
 * chat, the fleet card and the journal all key on — so a leftover here is exactly "a process belonging to a turn
 * that has finished", with no fourth definition of alive to keep true. One-shots (the title namer and its kind)
 * name a conversation nothing will ever report live, which is honest: bounded to maxTurns 1 and toolless, one that
 * outlives its grace window is broken by construction.
 *
 * THE BOOT ID is what makes a daemon's death survivable. Nothing this process started may outlive it — the
 * turn journal already reasons this way about turns, and their processes are the same fact one layer down — so a
 * stamp from another life needs no owner lookup at all. It is reclaimable the moment it is seen.
 *
 * WHAT IS DELIBERATELY EXEMPT is anything under a tmux pane. A pane is a place with a watcher: the user has a tab
 * on it, the terminals list shows it, and terminal-session.ts already ages it out on a policy that knows about
 * attachment and dead panes. A `codex exec` delegation inherits its parent turn's stamp and can legitimately run
 * on past the turn that started it, with the owner reading along — reaping that would be this sweep destroying
 * work someone is watching. Ancestry is walked rather than matched on the pane's own pid, because the thing
 * actually holding the memory is several forks below the shell.
 *
 * And the sweep only ever touches what carries OUR stamp. A sandbox is a machine people run their own daemons on;
 * a rule phrased as "orphaned processes" would eventually meet somebody's deliberate `nohup … &` and be right
 * about the parent and wrong about everything else. */

// The stamp, and the vocabulary for reading it back. `<bootId>:<owner>` — two opaque tokens either side of a
// colon, so an owner that ever grows a colon of its own still parses (the boot id cannot: it is minted here).
export const WORKLOAD_ENV = "INTENTIC_WORKLOAD";

/* This daemon's life, minted once at import. Not persisted anywhere: its whole job is to be different from
 * whatever the last life used, and a value nobody can predict is the cheapest way to guarantee that. */
export const BOOT_ID = `${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`;

// The env a spawned workload gets, to be spread into the child's environment. Owner is the conversation the work
// belongs to; a flow with no conversation of its own passes one of the two reserved names below.
export const workloadStamp = (owner: string): Record<string, string> => ({ [WORKLOAD_ENV]: `${BOOT_ID}:${owner}` });

/* THE TWO OWNERS THAT ARE NOT CONVERSATIONS.
 *
 * `daemon` is for what the daemon keeps across turns on purpose — the pooled ACP agent processes. It is always
 * live in this life, so the in-life sweep never touches one; what the stamp buys is the OTHER half, since a pool
 * process from a previous daemon is indistinguishable from a live one by any other means and nothing adopts it.
 *
 * `one-shot` is the helper calls (agent/one-shot.ts): toolless, maxTurns 1, and unwilling to wait even fifteen
 * seconds on a retry because "the answer is worthless by the time it arrives". Nothing will ever report it live,
 * which is the honest answer — there is no run to ask about — and one still breathing a grace window later has
 * outlived every purpose it had. These are the ones actually caught in the wild: a dozen of them at a time,
 * reparented to init, the oldest 37 minutes old. */
export const DAEMON_OWNER = "daemon";
export const ONE_SHOT_OWNER = "one-shot";

export interface WorkloadStamp {
    readonly bootId: string;
    readonly owner: string;
}

export const parseStamp = (value: string | undefined): WorkloadStamp | undefined => {
    const colon = value?.indexOf(":") ?? -1;
    if (value === undefined || colon <= 0) {
        return undefined;
    }
    return { bootId: value.slice(0, colon), owner: value.slice(colon + 1) };
};

// One process as the sweep needs to see it. `ppid` is only ever used to walk upward looking for a pane.
export interface ScannedProcess {
    readonly pid: number;
    readonly ppid: number;
    readonly stamp: WorkloadStamp | undefined;
}

// Why a process is reclaimable, which is also the difference between reclaiming it now and giving it a grace
// window: a stamp from a previous daemon life cannot become legitimate again, an owner that has just finished
// might still be unwinding.
export type LeftoverReason = "previous-boot" | "owner-finished";

export interface Leftover {
    readonly pid: number;
    readonly owner: string;
    readonly reason: LeftoverReason;
}

export interface LeftoverPolicy {
    readonly bootId: string;
    // Whether this owner still has work in flight. Injected because the answer lives in the turn registry, and
    // this module deliberately knows nothing about turns.
    readonly ownerLive: (owner: string) => boolean;
    // Every live tmux pane's root pid. A stamped process descending from one of these is somebody's visible
    // work and is never touched here.
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

/* The pure decision: which stamped processes nobody owns, and why. No clock — the grace window belongs to the
 * sweep, which is the only thing that can say how long a pid has been in this state. */
export const leftoverProcesses = (scanned: readonly ScannedProcess[], { bootId, ownerLive, panePids }: LeftoverPolicy): Leftover[] => {
    const parents = new Map(scanned.map((entry) => [entry.pid, entry.ppid]));
    const leftovers: Leftover[] = [];
    for (const { pid, stamp } of scanned) {
        if (stamp === undefined || underPane(pid, parents, panePids)) {
            continue;
        }
        if (stamp.bootId !== bootId) {
            leftovers.push({ pid, owner: stamp.owner, reason: "previous-boot" });
            continue;
        }
        if (!ownerLive(stamp.owner)) {
            leftovers.push({ pid, owner: stamp.owner, reason: "owner-finished" });
        }
    }
    return leftovers;
};

/* THE SCAN. Two small procfs reads per process, which is why this runs on a minute-scale timer and not the
 * 250ms one workload-priority affords: `environ` is a copy of the child's whole environment block and there are a
 * couple of hundred processes in a busy sandbox.
 *
 * A pid that vanishes between readdir and either read is the normal case, not an error — the sweep is looking at
 * a moving system and simply does not see that one this pass. */
const NUMERIC = /^\d+$/u;

// `stat`'s second field is the executable name in parentheses and may itself contain spaces and parentheses, so
// the only safe split is after the LAST `)`: ppid is then the second field of what remains.
export const parsePpid = (stat: string): number | undefined => {
    const rest = stat
        .slice(stat.lastIndexOf(")") + 1)
        .trim()
        .split(/\s+/u);
    const ppid = Number(rest[1]);
    return Number.isSafeInteger(ppid) && ppid >= 0 ? ppid : undefined;
};

// procfs hands back the environment NUL-separated, in the form it had at exec — which is what we want: a child
// cannot edit its way out of the stamp it was born with.
export const stampOf = (environ: string): WorkloadStamp | undefined => {
    for (const entry of environ.split("\0")) {
        if (entry.startsWith(`${WORKLOAD_ENV}=`)) {
            return parseStamp(entry.slice(WORKLOAD_ENV.length + 1));
        }
    }
    return undefined;
};

const scanProcess = async (pid: number): Promise<ScannedProcess | undefined> => {
    try {
        const [stat, environ] = await Promise.all([readFile(`/proc/${pid}/stat`, "utf8"), readFile(`/proc/${pid}/environ`, "utf8")]);
        const ppid = parsePpid(stat);
        return ppid === undefined ? undefined : { pid, ppid, stamp: stampOf(environ) };
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

/* HOW LONG AN OWNER MAY BE GONE before its processes are. Long enough that a turn's own unwind — the SDK's
 * stdin-EOF, its grace, its SIGTERM, and whatever the CLI then does to its MCP servers — has plainly had its
 * chance and not taken it; short enough that a browser profile does not sit on half a gigabyte for the rest of
 * the afternoon. A previous life's processes wait for none of this. */
const GRACE_MS = 3 * 60_000;

// SIGTERM first and SIGKILL only on the pass after, so a process with a shutdown path gets to run it. The two
// signals are a window apart by construction: `killed` remembers what has already been asked nicely.
const signalFor = (pid: number, asked: ReadonlySet<number>): NodeJS.Signals => (asked.has(pid) ? "SIGKILL" : "SIGTERM");

export interface LeftoverSweep {
    readonly sweep: () => Promise<void>;
    readonly stop: () => void;
}

export interface LeftoverSweepOptions {
    readonly ownerLive: (owner: string) => boolean;
    readonly panePids: () => Promise<Map<number, string>>;
    readonly logger: Logger;
    readonly graceMs?: number;
    readonly intervalMs?: number;
}

/* The sweep itself: stateful only in the two things a single pass cannot know — since when a pid has been
 * unowned, and which pids have already been asked to leave. Both are keyed by pid and pruned to what the current
 * pass can still see, so a pid that exits (or is reused) carries nothing forward. */
export const startLeftoverSweep = ({ ownerLive, panePids, logger, graceMs = GRACE_MS, intervalMs = 60_000 }: LeftoverSweepOptions): LeftoverSweep => {
    const unownedSince = new Map<number, number>();
    const asked = new Set<number>();
    let running = false;

    const sweep = async (): Promise<void> => {
        if (running || process.platform !== "linux") {
            return;
        }
        running = true;
        try {
            const [scanned, panes] = await Promise.all([scanProcesses(), panePids().catch(() => new Map<number, string>())]);
            const leftovers = leftoverProcesses(scanned, { bootId: BOOT_ID, ownerLive, panePids: new Set(panes.keys()) });
            const seen = new Set(leftovers.map((entry) => entry.pid));
            for (const pid of unownedSince.keys()) {
                if (!seen.has(pid)) {
                    unownedSince.delete(pid);
                    asked.delete(pid);
                }
            }
            const now = Date.now();
            const reclaimed: Leftover[] = [];
            for (const leftover of leftovers) {
                const since = unownedSince.get(leftover.pid) ?? now;
                unownedSince.set(leftover.pid, since);
                // A previous life's processes have no owner that could come back, so they skip the window.
                if (leftover.reason === "owner-finished" && now - since < graceMs) {
                    continue;
                }
                try {
                    process.kill(leftover.pid, signalFor(leftover.pid, asked));
                    reclaimed.push(leftover);
                    asked.add(leftover.pid);
                } catch {
                    // Already gone, or not ours to signal. Either way the next pass sees the truth.
                }
            }
            if (reclaimed.length > 0) {
                logger.info(
                    {
                        reclaimed: reclaimed.length,
                        previousBoot: reclaimed.filter((entry) => entry.reason === "previous-boot").length,
                        owners: [...new Set(reclaimed.map((entry) => entry.owner))].slice(0, 10),
                    },
                    "leftovers: reclaimed processes whose turn had finished",
                );
            }
        } catch (error) {
            logger.warn({ err: error }, "leftovers: sweep failed");
        } finally {
            running = false;
        }
    };

    const timer = setInterval(() => void sweep(), intervalMs);
    // The sweep must never be what keeps the daemon alive.
    timer.unref();
    return { sweep, stop: () => clearInterval(timer) };
};
